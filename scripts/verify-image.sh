#!/usr/bin/env bash
# Checks an image in a throw-away container started with the recommended hardening: which methods work, whether hostile
# targets are refused, the response headers, speed, a burst of load, and that the container is unharmed afterwards.
# Nothing else on the machine is touched: one container (pt-verify) and, if it does not exist yet, one network that is removed again.
# Usage: scripts/verify-image.sh IMAGE
#   VERIFY_HOST   the one allowed host to render (default example.com; it must be reachable from this machine)
#   VERIFY_PORT   the loopback port for the test container (default 3903)
# Exit code 0 when every check passed, 1 when any failed or the container did not start.
set -uo pipefail

IMAGE="${1:?usage: verify-image.sh IMAGE}"
HOST="${VERIFY_HOST:-example.com}"
PORT="${VERIFY_PORT:-3903}"
NAME=pt-verify
NET=pt-verify-net
BASE="http://127.0.0.1:$PORT"
PASS=0
FAIL=0
made_net=0

ok()  { PASS=$((PASS + 1)); echo "PASS  $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL  $1  ($2)"; }
code() { curl -s -o /dev/null -m 40 -w '%{http_code}' "$@"; }
want() { # want LABEL REGEX curl-args...
  local label="$1" re="$2" c
  shift 2
  c=$(code "$@")
  [[ "$c" =~ ^($re)$ ]] && ok "$label -> $c" || bad "$label" "got $c, want $re"
}

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  [ "$made_net" = 1 ] && docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if docker inspect "$NAME" >/dev/null 2>&1; then
  echo "A container called $NAME already exists. Remove it first (docker rm -f $NAME); this script will not touch it."
  trap - EXIT
  exit 1
fi
if curl -s -o /dev/null -m 2 "$BASE/" 2>/dev/null; then
  echo "Port $PORT is already answering. Set VERIFY_PORT to a free port."
  trap - EXIT
  exit 1
fi
if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET" >/dev/null && made_net=1
fi

echo "image: $IMAGE"
if ! docker run -d --name "$NAME" --network "$NET" -p "127.0.0.1:$PORT:3000" \
  --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 2g --cpus 2 \
  -e ALLOWED_HOSTS="$HOST" -e REQUEST_TIMEOUT_MS=14000 -e PAGE_LOAD_TIMEOUT_MS=10000 \
  -e METRICS_ENABLED=true -e CACHE_TTL_S=3600 "$IMAGE" >/dev/null; then
  echo "RESULT: the container could not be created"
  exit 1
fi
echo -n "waiting for health "
up=0
for _ in $(seq 1 60); do
  [ "$(code "$BASE/healthz")" = 200 ] && { up=1; break; }
  [ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ] || break
  echo -n .
  sleep 2
done
echo
if [ "$up" != 1 ]; then
  echo "RESULT: the container never became healthy; last log lines:"
  docker logs --tail 30 "$NAME" 2>&1
  exit 1
fi

PAGE="$BASE/https://$HOST/"

echo "== 1 health and a real render"
want "healthz" 200 "$BASE/healthz"
want "GET allowed page" 200 "$PAGE"
want "GET allowed page again (cache)" 200 "$PAGE"

echo "== 2 methods (only GET and HEAD may work)"
want "HEAD page" 200 -I "$PAGE"
raw=$(exec 3<>"/dev/tcp/127.0.0.1/$PORT" && printf 'HEAD /https://%s/ HTTP/1.0\r\nHost: x\r\n\r\n' "$HOST" >&3 && timeout 20 cat <&3)
bodybytes=$(printf '%s' "$raw" | sed '1,/^\r\{0,1\}$/d' | wc -c)
[ "$bodybytes" = 0 ] && ok "HEAD has no body" || bad "HEAD has no body" "$bodybytes bytes after the headers"
for m in POST PUT DELETE PATCH OPTIONS TRACE PROPFIND; do
  want "$m refused" 405 -X "$m" "$PAGE"
done
allow=$(curl -s -m 20 -D - -o /dev/null -X POST "$PAGE" | tr -d '\r' | grep -i '^allow:')
[[ "$allow" == *GET* && "$allow" == *HEAD* ]] && ok "405 carries Allow header ($allow)" || bad "Allow header" "${allow:-missing}"
c=$(head -c 1048576 /dev/zero | curl -s -o /dev/null -m 40 -w '%{http_code}' -X POST --data-binary @- "$PAGE")
[ "$c" = 405 ] && ok "POST with a 1 MB body refused -> 405" || bad "POST with a 1 MB body" "got $c"

echo "== 3 hostile targets (must be refused, never 2xx or 5xx)"
refuse() { want "refuse: $1" '400|403|404|414' --path-as-is "$BASE/$2"; }
refuse "other host"        "https://example.invalid/"
refuse "localhost address" "http://127.0.0.1:3000/healthz"
refuse "localhost name"    "http://localhost/"
refuse "cloud metadata"    "http://169.254.169.254/latest/meta-data/"
refuse "private 10.x"      "http://10.0.0.1/"
refuse "private 192.168.x" "http://192.168.1.1/"
refuse "IPv6 loopback"     "http://[::1]/"
refuse "IPv4-mapped IPv6"  "http://[::ffff:127.0.0.1]/"
refuse "decimal IP"        "http://2130706433/"
refuse "hex IP"            "http://0x7f000001/"
refuse "userinfo trick"    "https://$HOST@evil.example/"
refuse "suffix trick"      "https://$HOST.evil.example/"
refuse "prefix trick"      "https://evil$HOST/"
refuse "file scheme"       "file:///etc/passwd"
refuse "javascript scheme" "javascript:alert(1)"
refuse "data scheme"       "data:text/html,hi"
refuse "ftp scheme"        "ftp://$HOST/"
refuse "no scheme"         "$HOST/"
refuse "path traversal"    "https://$HOST/../../etc/passwd"
refuse "encoded traversal" "https://$HOST/%2e%2e/%2e%2e/etc/passwd"
refuse "null byte"         "https://$HOST/%00"
refuse "CRLF in path"      "https://$HOST/%0d%0aX-Evil:1"
want "refuse: odd port (blocked at the egress proxy, so the page fails to load)" '400|403|404|502|504' --path-as-is "$BASE/https://$HOST:22/"
refuse "double scheme"     "https://https://$HOST/"
want "very long URL (20 kB)" '400|403|404|414|431' "$BASE/https://$HOST/$(head -c 20000 /dev/zero | tr '\0' a)"
want "huge header (20 kB)" '400|431|494' -H "X-Big: $(head -c 20000 /dev/zero | tr '\0' a)" "$BASE/healthz"

echo "== 4 response headers"
h=$(curl -s -m 40 -D - -o /dev/null "$PAGE" | tr -d '\r')
echo "$h" | grep -qi '^x-powered-by' && bad "no X-Powered-By" "present" || ok "no X-Powered-By"
echo "$h" | grep -qi '^server:' && bad "no Server header" "$(echo "$h" | grep -i '^server:')" || ok "no Server header"
echo "$h" | grep -qi '^content-type:.*text/html' && ok "content-type html" || bad "content-type" "not html"
curl -s -m 20 "$BASE/metrics" | grep -q '^prerender_' && ok "metrics served" || bad "metrics" "empty"

echo "== 5 speed and load"
t1=$(curl -s -o /dev/null -m 40 -w '%{time_total}' "$PAGE?speed=1")
t2=$(curl -s -o /dev/null -m 40 -w '%{time_total}' "$PAGE?speed=1")
echo "      first render ${t1}s, cached ${t2}s"
awk "BEGIN{exit !($t2 < 0.5)}" && ok "cached page under 0.5 s" || bad "cache speed" "${t2}s"
res=$(seq 1 40 | xargs -P 20 -I{} curl -s -o /dev/null -m 60 -w '%{http_code}\n' "$PAGE?same=1" | sort | uniq -c | tr '\n' ' ')
echo "      40 requests for one page, 20 at once: $res"
echo "$res" | grep -Eq ' (5[0-9][0-9]|000)' && bad "burst load" "$res" || ok "burst load: no 5xx, none dropped"
res=$(seq 1 30 | xargs -P 15 -I{} curl -s -o /dev/null -m 60 -w '%{http_code}\n' "$PAGE?distinct={}" | sort | uniq -c | tr '\n' ' ')
echo "      30 different uncached pages, 15 at once: $res"
echo "$res" | grep -Eq ' (5[0-9][0-9]|000)' && bad "uncached load" "$res" || ok "uncached load: no 5xx, none dropped"

echo "== 6 container state after the abuse"
want "healthz after" 200 "$BASE/healthz"
st=$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}} oom={{.State.OOMKilled}}' "$NAME")
echo "      $st"
[[ "$st" == "running restarts=0 oom=false" ]] && ok "no restart, no OOM" || bad "container state" "$st"
docker stats --no-stream --format '      memory {{.MemUsage}}   cpu {{.CPUPerc}}   processes {{.PIDs}}' "$NAME"
echo "      log lines that look like errors: $(docker logs "$NAME" 2>&1 | grep -ciE 'error|exception|unhandled')"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
