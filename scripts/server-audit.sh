#!/usr/bin/env bash
# Read-only security and performance audit for a server that runs this image.
#
# What it touches:
#   * The production container (default name "prerender") is only INSPECTED: docker inspect, docker stats --no-stream and
#     docker logs --tail. Nothing is started, stopped, restarted or sent to it.
#   * Everything that is attacked or load-tested runs in separate throw-away containers named pt-* on their own network
#     (pt-net), bound to 127.0.0.1 on a spare port, limited to 2 CPUs and 1 GB, and removed again on exit (also on Ctrl+C).
#   * nginx, redis, mongodb and any other container are never touched.
#
# Usage:  bash scripts/server-audit.sh [production-container-name] [test-port]
# Needs:  docker, curl, and (for the real-site timings) outbound access to the allowed site.
# Output: PASS / FAIL / INFO lines. A FAIL means something should be fixed; nothing is changed automatically.

set -u
PROD="${1:-prerender}"
PORT="${2:-3902}"
NET=pt-net
SITE_HOSTS="${AUDIT_SITE_HOSTS:-stagerage.online,www.stagerage.online}"
REAL_URL="${AUDIT_REAL_URL:-https://stagerage.online/}"
FAILS=0
RESTARTS0=""

pass() { printf 'PASS  %s\n' "$*"; }
info() { printf 'INFO  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check "description" expected actual
  if [ "$2" = "$3" ]; then pass "$1 ($3)"; else fail "$1: expected $2, got $3"; fi
}

cleanup() {
  docker rm -f pt-audit pt-site pt-secret >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

command -v docker >/dev/null || { echo "docker is required"; exit 2; }
command -v curl >/dev/null || { echo "curl is required"; exit 2; }
if ! docker inspect "$PROD" >/dev/null 2>&1; then echo "No container named $PROD. Pass its name as the first argument."; exit 2; fi
if docker inspect pt-audit >/dev/null 2>&1 || docker inspect pt-site >/dev/null 2>&1 || docker inspect pt-secret >/dev/null 2>&1; then
  echo "A pt-* container already exists from an earlier run. Remove it with: docker rm -f pt-audit pt-site pt-secret"; exit 2
fi
if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/healthz"; then echo "Port $PORT is in use. Pass another test port as the second argument."; exit 2; fi

echo "== 1. Production container, inspected only ($PROD) =="
IMAGE_ID=$(docker inspect --format '{{.Image}}' "$PROD")
info "image id: $IMAGE_ID"
info "image tags/digests: $(docker inspect --format '{{.Config.Image}}' "$PROD")"
check "runs as an unprivileged user" "node" "$(docker inspect --format '{{.Config.User}}' "$PROD" | sed 's/^$/root/')"
check "root filesystem is read-only" "true" "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$PROD")"
check "not privileged" "false" "$(docker inspect --format '{{.HostConfig.Privileged}}' "$PROD")"
check "all capabilities dropped" "[ALL]" "$(docker inspect --format '{{.HostConfig.CapDrop}}' "$PROD")"
case "$(docker inspect --format '{{.HostConfig.SecurityOpt}}' "$PROD")" in *no-new-privileges*) pass "no-new-privileges is set";; *) fail "no-new-privileges is not set";; esac
case "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$PROD")" in host) fail "uses host networking";; *) pass "does not use host networking";; esac
MEM=$(docker inspect --format '{{.HostConfig.Memory}}' "$PROD"); [ "$MEM" -gt 0 ] 2>/dev/null && pass "memory limit set ($((MEM / 1048576)) MiB)" || fail "no memory limit"
PIDS=$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$PROD"); [ "${PIDS:-0}" -gt 0 ] 2>/dev/null && pass "pids limit set ($PIDS)" || fail "no pids limit"
BINDS=$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$PROD")
case "$BINDS" in *"0.0.0.0"*|*":::"*) fail "published on all interfaces: $BINDS";; "") info "no published ports";; *) pass "published only on: $BINDS";; esac
info "restart policy: $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$PROD")"
info "health: $(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no healthcheck{{end}}' "$PROD")"
RESTARTS0=$(docker inspect --format '{{.RestartCount}}' "$PROD")
info "restarts since creation: $RESTARTS0"
info "mounts: $(docker inspect --format '{{range .Mounts}}{{.Type}}:{{.Destination}} {{end}}' "$PROD")"
info "environment variable NAMES (values are not shown): $(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PROD" | sed 's/=.*//' | grep -v '^$' | tr '\n' ' ')"
info "usage now: $(docker stats --no-stream --format '{{.CPUPerc}} cpu, {{.MemUsage}}, {{.PIDs}} pids' "$PROD")"
LOGS=$(docker logs --tail 2000 "$PROD" 2>&1)
info "last 2000 log lines: $(printf '%s\n' "$LOGS" | grep -c 'page timed out') page timeouts, $(printf '%s\n' "$LOGS" | grep -c 'egress blocked') blocked egress attempts, $(printf '%s\n' "$LOGS" | grep -c -i 'wrote off') orphan write-offs"
if printf '%s\n' "$LOGS" | grep -q -E 'ERR_|TypeError|ReferenceError|UnhandledPromise|FATAL'; then fail "errors found in the recent log (look at: docker logs --tail 2000 $PROD | grep -E 'ERR_|TypeError|ReferenceError|UnhandledPromise|FATAL')"; else pass "no crash-type errors in the recent log"; fi
HOSTPORT=$(docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}}{{end}}{{end}}' "$PROD")
if [ -n "$HOSTPORT" ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$HOSTPORT/healthz"); check "production /healthz answers" "200" "$code"
  m=$(curl -s --max-time 5 "http://127.0.0.1:$HOSTPORT/metrics" | grep -E '^prerender_(requests|rendered|timeouts|refused|queue_full|shed_memory|cache_hits|cache_misses|cache_entries|cache_bytes|oversize)' | tr '\n' ' ')
  info "production metrics (read only): ${m:-metrics are off}"
fi

echo
echo "== 2. Throw-away test containers (same image as production) =="
docker network create --internal=false "$NET" >/dev/null || { echo "could not create $NET"; exit 2; }
HARDEN=(--read-only --tmpfs /tmp:size=256m --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 256 --memory 1g --cpus 2 --network "$NET")
# A site that is on the allow list and serves a hostile page, and a "secret" service that must never be contacted.
SECRET_JS="require('http').createServer((q,s)=>{console.log('HIT '+q.method+' '+q.url);s.writeHead(200,{'access-control-allow-origin':'*'});s.end('SECRET')}).listen(8080)"
docker run -d --name pt-secret "${HARDEN[@]}" --entrypoint node "$IMAGE_ID" -e "$SECRET_JS" >/dev/null
SITE_JS="require('http').createServer((q,s)=>{console.log('SITEHIT '+q.url);s.writeHead(200,{'content-type':'text/html'});s.end('<!doctype html><title>t</title><body><div id=o>x</div><script>'+
 'var t=[\"http://pt-secret:8080/fetch\",\"http://169.254.169.254/latest/meta-data/\",\"http://[::ffff:a9fe:a9fe]/\",\"http://[64:ff9b::a9fe:a9fe]/\",\"http://2130706433:8080/\",\"http://localhost:8080/\"];'+
 't.forEach(function(u){try{fetch(u,{mode:\"no-cors\"}).catch(function(){})}catch(e){}});'+
 'var i=new Image();i.src=\"http://pt-secret:8080/img\";'+
 'try{new WebSocket(\"ws://pt-secret:8080/ws\")}catch(e){}'+
 'setTimeout(function(){document.getElementById(\"o\").textContent=\"hostile page rendered\"},200)</script></body>')}).listen(8081)"
docker run -d --name pt-site "${HARDEN[@]}" --entrypoint node "$IMAGE_ID" -e "$SITE_JS" >/dev/null
docker run -d --name pt-audit "${HARDEN[@]}" -p "127.0.0.1:$PORT:3000" \
  -e "ALLOWED_HOSTS=pt-site,$SITE_HOSTS" -e REQUEST_TIMEOUT_MS=14000 -e PAGE_LOAD_TIMEOUT_MS=10000 -e METRICS_ENABLED=true \
  -e CACHE_TTL_S=60 -e DIAGNOSTICS=false "$IMAGE_ID" >/dev/null
ready=0; for _ in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PORT/healthz")" = 200 ] && { ready=1; break; }; sleep 1; done
[ "$ready" = 1 ] && pass "test container is up on 127.0.0.1:$PORT" || { fail "test container did not become healthy"; docker logs --tail 30 pt-audit; exit 1; }
B="http://127.0.0.1:$PORT"
code() { curl -s -o /dev/null -w '%{http_code}' --max-time "${2:-30}" "$1"; }

echo
echo "== 3. Attacks on the test container =="
check "host that is not allowed is refused" "403" "$(code "$B/http://example.org/")"
check "private address literal is refused" "403" "$(code "$B/http://169.254.169.254/")"
check "loopback is refused" "403" "$(code "$B/http://127.0.0.1:3000/")"
check "IPv6 mapped metadata address is refused" "403" "$(code "$B/http://[::ffff:a9fe:a9fe]/")"
check "user-info trick is refused" "403" "$(code "$B/http://pt-site@example.org/")"
check "file: scheme is refused" "400" "$(code "$B/file:///etc/passwd")"
check "broken percent-escape gets a fixed 400" "400" "$(code "$B/http://pt-site:8081/%zz")"
check "control character in path is refused" "400" "$(code "$B/http://pt-site:8081/a%0d%0ab")"
check "POST is refused" "405" "$(curl -s -o /dev/null -w '%{http_code}' -X POST --max-time 5 "$B/http://pt-site:8081/")"
check "very long URL is refused" "414" "$(code "$B/http://pt-site:8081/$(head -c 4000 /dev/zero | tr '\0' a)")"
body=$(curl -s --max-time 5 "$B/nothing"); case "$body" in *"/app"*|*"node_modules"*|*"at "*) fail "error page leaks internals: $body";; *) pass "error page has no paths or stack traces";; esac
hdrs=$(curl -s -D - -o /dev/null --max-time 5 "$B/healthz"); case "$hdrs" in *[Ss]erver:*|*[Xx]-[Pp]owered-[Bb]y*) fail "version-revealing header present";; *) pass "no Server or X-Powered-By header";; esac

echo
echo "== 4. A hostile page tries to reach a private service =="
out=$(curl -s --max-time 40 "$B/http://pt-site:8081/page")
case "$out" in *"hostile page rendered"*) pass "the hostile page itself rendered";; *) fail "hostile page did not render (got: ${out:0:80})";; esac
sleep 2
SECRET_HITS=$(docker logs pt-secret 2>&1 | grep -c '^HIT')
check "the secret service was contacted $SECRET_HITS times" "0" "$SECRET_HITS"
info "egress refusals in the test container log: $(docker logs pt-audit 2>&1 | grep -c 'egress blocked')"
metric() { curl -s --max-time 5 "$B/metrics" | awk -v n="$1" '$1 == n { print $2 }'; }

echo
echo "== 5. Performance (real site: $REAL_URL) =="
T() { curl -s -o /dev/null -w '%{http_code} %{time_total}s %{size_download}B' --max-time 40 "$1"; }
info "cold render:  $(T "$B/$REAL_URL")"
info "warm (cache): $(T "$B/$REAL_URL")"
start=$(date +%s.%N)
for i in $(seq 1 12); do curl -s -o /dev/null --max-time 60 "$B/${REAL_URL}?burst=1" & done; wait
end=$(date +%s.%N)
info "12 simultaneous callers for one new page: $(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.1f s", b-a}'), coalesced waiters: $(metric prerender_coalesced_total)"
start=$(date +%s.%N); for i in $(seq 1 300); do curl -s -o /dev/null "$B/$REAL_URL"; done; end=$(date +%s.%N)
info "300 cached answers one after another: $(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.2f s (%.1f ms each, includes curl start-up)", b-a, (b-a)*1000/300}')"
info "cache: $(metric prerender_cache_entries) entries, $(metric prerender_cache_bytes) bytes; in flight $(metric prerender_in_flight); queued $(metric prerender_queued)"
info "test container usage: $(docker stats --no-stream --format '{{.CPUPerc}} cpu, {{.MemUsage}}, {{.PIDs}} pids' pt-audit)"
check "health still fine after the load" "200" "$(code "$B/healthz" 5)"
check "no slot left taken" "0" "$(metric prerender_in_flight)"

echo
echo "== 6. Production again (it must be unchanged) =="
if [ -n "$HOSTPORT" ]; then check "production /healthz still answers" "200" "$(code "http://127.0.0.1:$HOSTPORT/healthz" 5)"; fi
check "production did not restart during the audit" "$RESTARTS0" "$(docker inspect --format '{{.RestartCount}}' "$PROD")"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: no FAIL lines."; else echo "RESULT: $FAILS FAIL line(s). Send this output back."; fi
echo "The pt-* containers and the pt-net network are removed now."
