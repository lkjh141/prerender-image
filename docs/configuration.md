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
| `LOG_REQUESTS` | `false` | Log every request (`+` when it starts, `-` when it finishes) and every request the page makes. |
| `DIAGNOSTICS` | `false` | Extra logging for finding problems: one line when each browser connection through the egress proxy opens (address, connect time) and closes (who closed it first, bytes each way), and a line for any browser request that stays paused for 3 s. Verbose; for a canary, not for production. |
| `PAGE_FILTER` | `true` | `false` switches off the per-page request filter (the browser's request interception). The egress proxy still enforces every network rule, so this keeps the SSRF protection; it only removes the second, in-page layer. For bisecting a problem, not a recommended setting. |

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
| `NAVIGATION_SETTLE_MS` | 750 | 100–10000 | When a page navigates itself (a script reload or redirect), the time given to requests of the old page to report back before they are written off. Chromium sometimes never reports a request that was started just before the navigation, and Prerender would then wait for it until the page-load timeout. |
| `MAX_RESPONSE_BYTES` | 10485760 | 1024–209715200 | Largest rendered page returned; larger gets 502. |
| `MAX_URL_LENGTH` | 2048 | 64–8192 | Longest request path accepted (414). |
| `MAX_CONNECTIONS` | 512 | 1–10000 | Open client connections. |
| `HEAP_SHED_PERCENT` | 85 | 50–99 | New requests get 503 while the Node heap is above this percent of its limit. |

## Render cache (optional, off by default)

A finished render can be kept in memory and served again without a browser. Set `CACHE_TTL_S` to switch it on.

| Variable | Default | Range | Meaning |
| --- | --- | --- | --- |
| `CACHE_TTL_S` | 0 (off) | 0–604800 | Seconds a render is kept. `0` means no cache. |
| `CACHE_MAX_MB` | 64 | 1–1024 | Memory the cache may use. It is outside the Node heap and counts against the container's memory limit, so add it to the sizing below. |
| `CACHE_MAX_ENTRIES` | 2000 | 1–100000 | Pages the cache may hold. |

What is kept, and what is not:

- **Kept:** a plain `200` render that finished cleanly. The cached answer is identical to the answer a render would give (same body, same filtered headers).
- **Never kept:** a render that hit the page-load timeout, one where a request of the page's own failed with a 5xx answer, one where the browser reported an error, any status other than 200 (so also 404, 301, 5xx), an empty page, and a page whose `Cache-Control` says `no-store` or `private`. A page that always hits the page-load timeout (for example one with a CAPTCHA widget that never finishes) is therefore rendered every time. The fix for such a page is on the site: set `window.prerenderReady = false` early and `true` when the content is there.
- **Key:** the full URL that is rendered, including the query string. A different query string is a different page. The answer does not depend on who asks: the service sends the browser nothing from the caller's request, so nothing about a caller can end up in a cached page.
- **Eviction:** least recently used first, by bytes and by entries. One page larger than a quarter of `CACHE_MAX_MB` is not kept.
- **Size:** on a real single-page app, 32 rendered pages (home, venue, news and the like) used 3.6 MB in the cache, about 110 KB each, so the default 64 MB holds roughly 600 pages of that size.
- **Hits are cheap:** a hit uses no browser, no render slot and no queue place, so it is also served while the service is busy or short of memory. The request is still checked first (URL, host allowlist), so a host that is not allowed never reaches the cache.
- **Observe:** the `X-Prerender-Cache: hit` or `miss` response header, and with `METRICS_ENABLED=true` the `prerender_cache_*` metrics.
- **Flush:** restart the container. There is no endpoint to flush it, on purpose: the service has no authentication, so nothing that changes state is exposed.

Choosing the TTL: after a deploy of your site, crawlers see the old render until the entry expires or the container restarts. Restart the container as part of the deploy, or use a TTL that you can live with. Because anyone who can reach the service can request many different query strings on an allowed host, the cache can be filled with junk; the limits keep that bounded and the least recently used entries go first, but it can push useful pages out. Rate-limit at your web server as for the render itself.

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
| `EGRESS_CONNECT_TIMEOUT_MS` | 8000 | 500–60000 | Longest the proxy waits to connect to a page's server, all of the name's addresses together. Addresses are tried in turn (IPv4 first), the next after 250 ms or as soon as one fails, so one unreachable address does not stall the page. |
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
- **A real single-page app.** Measured on a 4 vCPU, 8 GB server with a 2 GB container: about 2 s for a page that loads web fonts, an error-reporting library and several API calls (1.75 to 2.35 s over 20 renders), up to 3.7 s each when 4 render at once, and 337 MiB of memory after about 110 renders. See the [test report](test-report.md#measured-on-a-real-production-site). A page with a widget that never finishes loading (a CAPTCHA, a chat widget that holds a connection open) takes the whole `PAGE_LOAD_TIMEOUT_MS`.
- **Caching.** Put a cache in front (nginx `proxy_cache`, your CDN). Rendering is the expensive part, and a crawler asking for the same page twice should not pay twice.

## Health and metrics

`GET /healthz` answers 200 only when the browser is connected and the service is not shutting down, otherwise 503. The image's Docker `HEALTHCHECK` and the
Kubernetes probes in the implementation guide use it.

With `METRICS_ENABLED=true`, `GET /metrics` returns Prometheus text: requests, rendered, refused, bad requests, queue full, queue timeouts, request
timeouts, upstream errors, oversize, abandoned, shed for memory, in flight, queued, browser tabs, browser connected, egress allowed/blocked/open connections, tabs closed
by the watchdog, memory recycles, frozen-browser kills, ignored unhandled rejections, browser memory, and the service's RSS and heap.
