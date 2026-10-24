#!/usr/bin/env bash
# Starts the image the way the README recommends (read-only, no capabilities) and checks that it renders a page built by a script,
# honours the status meta tag, refuses other hosts, runs as an unprivileged user and reports healthy.
# Usage: scripts/smoke.sh IMAGE
set -euo pipefail

image="${1:?usage: smoke.sh IMAGE}"
name="prerender-smoke-$$"
work="$(mktemp -d)"
service_port=3300
site_port=8089

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    echo "--- container log ---"
    docker logs "$name" 2>&1 | tail -n 60 || true
  fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  [ -n "${site_pid:-}" ] && kill "$site_pid" 2>/dev/null || true
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT

cat > "$work/index.html" <<'HTML'
<!doctype html><html><head><title>smoke</title></head>
<body><div id="out">loading</div><script>document.getElementById('out').textContent = 'rendered by script';</script></body></html>
HTML
cat > "$work/missing.html" <<'HTML'
<!doctype html><html><head><meta name="prerender-status-code" content="404"><title>gone</title></head>
<body><div id="out">gone page</div></body></html>
HTML

python3 -m http.server "$site_port" --bind 127.0.0.1 --directory "$work" >/dev/null 2>&1 &
site_pid=$!

docker run -d --name "$name" --network host \
  --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges:true \
  -e PORT="$service_port" -e BROWSER_DEBUGGING_PORT=9333 -e ALLOWED_HOSTS=127.0.0.1 \
  "$image" >/dev/null

echo "waiting for the service"
for _ in $(seq 1 90); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/healthz")" = "200" ]; then break; fi
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/healthz")" = "200" ] || { echo "the service never became ready"; exit 1; }

echo "renders a page built by a script"
body="$(curl -sf "http://127.0.0.1:$service_port/http://127.0.0.1:$site_port/index.html")"
echo "$body" | grep -q "rendered by script"
if echo "$body" | grep -qi "<script"; then echo "script tags were not removed"; exit 1; fi

echo "honours the status meta tag"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/http://127.0.0.1:$site_port/missing.html")"
[ "$code" = "404" ] || { echo "expected 404, got $code"; exit 1; }

echo "refuses hosts that are not allowed"
for target in "http://example.org/" "http://169.254.169.254/latest/meta-data/" "http://localhost/"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/$target")"
  [ "$code" = "403" ] || { echo "expected 403 for $target, got $code"; exit 1; }
done
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/file:///etc/passwd")"
{ [ "$code" = "400" ] || [ "$code" = "403" ]; } || { echo "expected a refusal for file:, got $code"; exit 1; }

echo "answers bad input with a short fixed text, never a stack trace"
for path in "/http://127.0.0.1:$site_port/%zz" "/http://127.0.0.1:$site_port/%c0%af" "/render?url=http://127.0.0.1:$site_port/" "/nonsense"; do
  reply="$(curl -s -w ' [%{http_code}]' "http://127.0.0.1:$service_port$path")"
  echo "$reply" | grep -Eq 'node_modules|/app/|at .*\(|Error:' && { echo "internals leaked for $path: $reply"; exit 1; }
  echo "$reply" | grep -Eq '\[(400|404)\]$' || { echo "unexpected answer for $path: $reply"; exit 1; }
done
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$service_port/render" -d '{"url":"http://127.0.0.1"}')"
[ "$code" = "405" ] || { echo "the render API should be closed, got $code"; exit 1; }
[ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$service_port/metrics")" = "404" ] || { echo "metrics are on without being asked for"; exit 1; }

echo "runs as an unprivileged user"
uid="$(docker exec "$name" id -u)"
[ "$uid" != "0" ] || { echo "the container runs as root"; exit 1; }

echo "has no package manager inside"
if docker exec "$name" sh -c 'command -v npm || command -v npx || command -v yarn || command -v corepack' >/dev/null 2>&1; then
  echo "a package manager is still in the image"; exit 1
fi

echo "reports healthy"
for _ in $(seq 1 30); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$name")"
  [ "$health" = "healthy" ] && break
  sleep 2
done
[ "$health" = "healthy" ] || { echo "health status is $health"; exit 1; }

echo "Chromium: $(docker exec "$name" chromium --version 2>/dev/null || true)"

echo "stops cleanly on SIGTERM"
started=$(date +%s)
docker stop -t 30 "$name" >/dev/null
exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$name")"
elapsed=$(( $(date +%s) - started ))
[ "$exit_code" = "0" ] || { echo "exit code $exit_code on stop"; exit 1; }
[ "$elapsed" -lt 20 ] || { echo "stopping took ${elapsed}s"; exit 1; }
echo "smoke test passed"
