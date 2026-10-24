# Configuration

All configuration is by environment variable. A value that is not valid (not a whole number, outside its range) stops the container with a
plain message; nothing is silently replaced by a default.

## What may be rendered

| Variable | Default | Meaning |
| --- | --- | --- |
| `ALLOWED_HOSTS` | none, **required** | Host names that may be rendered, comma separated. Exact names only: no wildcards, ports or schemes. A host listed here may be a private address (a development page). |
| `ALLOW_ANY_HOST` | `false` | `true` renders any **public** host. Private and local addresses stay refused. |
| `ALLOW_PRIVATE_TARGETS` | `false` | `true` also lets pages reach private addresses. Only for a network with nothing sensitive on it. |
| `ALLOW_INVALID_CERTS` | `false` | `true` accepts expired, self-signed and wrong-host certificates (the stock Prerender behaviour). For development only. |
| `BLOCK_RESOURCES` | `false` | `true` also refuses trackers, ad networks, fonts and images while rendering. Faster pages; the text does not depend on them. |
| `EGRESS_ALLOWED_PORTS` | `80,443` | Ports a page may reach on hosts that are not in `ALLOWED_HOSTS`. |

## Where it listens

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Public port of the front server. |
| `HOST` | `0.0.0.0` | Address the front server binds inside the container. Publish it on loopback only (`127.0.0.1:3000:3000`). |
| `BROWSER_DEBUGGING_PORT` | `9222` | Chromium's DevTools port, inside the container, never reachable from a page. |
| `METRICS_ENABLED` | `false` | `true` serves Prometheus text on `/metrics` (same port; do not expose it publicly). |
| `LOG_REQUESTS` | `false` | Log every request. |

## Limits

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `MAX_CONCURRENCY` | 4 | 1–64 | Pages rendered at once. Each costs roughly 100–250 MB of browser memory and about one CPU core while loading. |
| `MAX_QUEUE` | 32 | 0–1024 | Requests allowed to wait for a free slot; more get 503 at once. |
| `QUEUE_TIMEOUT_MS` | 10000 | 100–120000 | Longest a request waits for a slot before 503. |
| `PAGE_LOAD_TIMEOUT_MS` | 20000 | 1000–120000 | Longest the page may take to load. |
| `REQUEST_TIMEOUT_MS` | 30000 | 1000–300000 | Hard deadline for one request, answered with 504. Must be larger than `PAGE_LOAD_TIMEOUT_MS`. |
| `WAIT_AFTER_LAST_REQUEST_MS` | 500 | 0–30000 | Quiet time after the page's last network request before it counts as finished. The biggest part of the latency of a simple page. Lower is faster and risks cutting off pages that start a follow-up request after a pause. |
| `PAGE_DONE_CHECK_INTERVAL_MS` | 100 | 20–5000 | How often the page is checked for being finished (adds up to this much delay). Prerender's own default is 500. |
| `MAX_RESPONSE_BYTES` | 10485760 | 1024–209715200 | Largest rendered page returned; larger gets 502. |
| `MAX_URL_LENGTH` | 2048 | 64–8192 | Longest request path accepted (414). |
| `MAX_CONNECTIONS` | 512 | 1–10000 | Open client connections. |
| `HEAP_SHED_PERCENT` | 85 | 50–99 | New requests get 503 while the Node heap is above this percent of its limit. |

## Housekeeping

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `TAB_MAX_AGE_MS` | 40000 | 5000–600000 | Age at which the watchdog closes a tab. Must be larger than `REQUEST_TIMEOUT_MS`. |
| `WATCHDOG_INTERVAL_MS` | 5000 | 200–60000 | Time between watchdog checks. |
| `BROWSER_PROBE_FAILURES` | 3 | 1–20 | Missed liveness checks before a frozen browser is killed. |
| `BROWSER_MAX_RSS_MB` | 1536 | 64–65536 | Browser memory (PSS, all processes) above which it is recycled. |
| `BROWSER_RECYCLE_COOLDOWN_S` | 60 | 1–86400 | Shortest time between two memory recycles. |
| `BROWSER_DOWN_EXIT_S` | 60 | 5–3600 | Seconds without a working browser before the container exits. |
| `DRAIN_TIMEOUT_MS` | 15000 | 0–120000 | Time given to running requests on SIGTERM. Keep the orchestrator's stop timeout above this. |
| `EGRESS_MAX_TUNNELS` | 256 | 1–10000 | Connections a page may hold open. |
| `EGRESS_IDLE_TIMEOUT_MS` | 30000 | 1000–600000 | Idle time before a page connection is closed. |
| `EGRESS_MAX_LIFETIME_MS` | 120000 | 1000–3600000 | Longest a single page connection may last. |
| `EGRESS_DNS_TTL_MS` | 30000 | 0–600000 | How long a resolved address is reused. |
| `CHROME_BIN` | `/usr/bin/chromium` | | The browser binary. |
| `CHROME_JS_HEAP_MB` | 512 | | Cap on one page's JavaScript heap (`--js-flags`). |
| `CHROME_PROFILE_DIR` | `/tmp/chromium-profile` | | Browser profile directory; keep it on the `/tmp` tmpfs. |

The image sets `NODE_OPTIONS=--max-old-space-size=384` (the service's own heap) and `UV_THREADPOOL_SIZE=16` (name lookups).

Prerender's own `FOLLOW_REDIRECTS`, `CAPTURE_CONSOLE_LOG`, `ENABLE_SERVICE_WORKER`, `PARSE_SHADOW_DOM`, `TIMEOUT_STATUS_CODE`,
`RENDERING_ERROR_STATUS_CODE` and `BROWSER_TRY_RESTART_PERIOD` are still read from the environment. The three timing variables
`PAGE_LOAD_TIMEOUT`, `WAIT_AFTER_LAST_REQUEST` and `PAGE_DONE_CHECK_INTERVAL` of version 1 are replaced by the `_MS` forms above and are **ignored**.

## Sizing

- **Memory.** Browser: about 200 MB idle plus 100–250 MB per page being rendered, so `MAX_CONCURRENCY=4` wants roughly 1–1.2 GB. Service: the
  heap holds each finished request for a few seconds, about 1–3 MB each, so at 3 pages a second expect 100–200 MB of the 384 MB heap. Above 85 % of the heap, requests are
  turned away rather than risking the process.
  The example in `compose.example.yaml` uses a 2 GB limit for that reason.
- **CPU.** A page load is bursty, up to one core. Measured on 4 cores: about 3.5 pages a second at `MAX_CONCURRENCY=4`.
- **Latency.** A simple page takes about 0.75 s, almost all of it the 500 ms quiet period plus the check interval. With `WAIT_AFTER_LAST_REQUEST_MS=200` it takes about 0.45 s.
- **Caching.** Put a cache in front (nginx `proxy_cache`, your CDN). Rendering is the expensive part, and a crawler asking for the same page twice should not pay twice.

## Health and metrics

`GET /healthz` answers 200 only when the browser is connected and the service is not shutting down, otherwise 503. The image's Docker `HEALTHCHECK` and the
Kubernetes probes in the implementation guide use it.

With `METRICS_ENABLED=true`, `GET /metrics` returns Prometheus text: requests, rendered, refused, bad requests, queue full, queue timeouts, request
timeouts, upstream errors, oversize, abandoned, shed for memory, in flight, queued, browser tabs, browser connected, egress allowed/blocked/open connections, tabs closed
by the watchdog, memory recycles, frozen-browser kills, ignored unhandled rejections, browser memory, and the service's RSS and heap.
