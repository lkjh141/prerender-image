# Architecture

## The pieces

```
                      public port (PORT, default 3000)
 your web server ───────────────┐
                                ▼
                     ┌─────────────────────┐   loopback only    ┌──────────────────────┐
                     │  front server       │ ─────────────────► │  Prerender 5.21.6    │
                     │  lib/front.js       │                    │  (Express + CDP)     │
                     └─────────────────────┘                    └──────────┬───────────┘
                       validates, limits,                                  │ DevTools protocol
                       queues, filters the                                 │ (loopback)
                       answer                                              ▼
                                                                ┌──────────────────────┐
   your site ◄──── egress proxy (lib/egress.js) ◄────────────── │  Chromium (headless) │
   (and what it         resolves names, refuses private         │  one browser context │
    loads)              addresses, pins the connection          │  per request         │
                                                                └──────────────────────┘
                     watchdog (lib/watchdog.js): stale tabs, memory, frozen browser
                     release plugin (lib/release.js): hands request memory back early
                     guard plugin (lib/guard.js): allowlist, strict TLS, dialogs, downloads
```

Everything runs in one container and one Node process, except Chromium and its helpers. `server.js` wires the parts together.

### Why a front server

Prerender is an Express app that starts listening by itself and exposes no hook for limits, error pages or health checks. It answers a
malformed percent-escape with a page that shows a stack trace and file paths, and its `/render` API accepts JavaScript to run in the page.
So Prerender is started on a loopback port that nothing outside the container can reach, and a small server of our own is the only public
listener. It is the part that is easy to reason about and test (`test/front.test.js`).

What the front server does, in order:

1. Accepts only `GET /<http or https URL>`, plus `/healthz` (and `/metrics` if enabled). Every other method gets 405, every other path 404 or 400.
   The `/render` API is not reachable.
2. Rejects control characters, undecodable escapes and over-long paths, with fixed one-line texts.
3. Computes the target URL **with Prerender's own function** and checks it against `ALLOWED_HOSTS` (403). The same check runs again inside
   Prerender, as a plugin, on the URL it will really fetch.
4. Admits the request: `MAX_CONCURRENCY` render at once, `MAX_QUEUE` wait up to `QUEUE_TIMEOUT_MS`, the rest get 503 immediately. A client that
   leaves while waiting gives its place up. New work is also refused while the heap is nearly full (`HEAP_SHED_PERCENT`) and while draining.
5. Forwards to Prerender, with a hard deadline (`REQUEST_TIMEOUT_MS`) and a cap on the size of the answer (`MAX_RESPONSE_BYTES`).
6. Builds the answer: only a short list of headers is passed on (no cookies, no security headers from the rendered site), status codes
   204/205/304 and anything outside 200 to 599 become 502, a `Location` must be http, https or a path, the body is always sent as
   `text/html; charset=utf-8`, and the service adds its own `nosniff`, `Referrer-Policy` and a restrictive `Content-Security-Policy`.

### The egress proxy

A page-level filter (intercepting requests in the tab) cannot see everything a browser opens: frames that run in a different process, WebSocket
connections, WebRTC, and DNS names that resolve to private addresses all get past it. Those four paths were reproduced against the first version of this
image (`test/adversarial/ssrf.test.js`, see the [test report](test-report.md)). The fix is at the network level: Chromium is started with
`--proxy-server` pointing at an in-process proxy, `--proxy-bypass-list=<-loopback>` (so even loopback goes through it) and
`--host-resolver-rules=MAP * ~NOTFOUND` (the browser resolves nothing itself).

For every connection the proxy:

- resolves the name itself and refuses the connection if **any** returned address is private, loopback, link-local, multicast or otherwise not public;
- connects to the exact address it checked, so the browser never gets a second resolution to race (DNS rebinding);
- never lets a page reach the service's own ports (public, Prerender, DevTools, the proxy), even if a loopback host is in `ALLOWED_HOSTS`;
- lets hosts listed in `ALLOWED_HOSTS` be private on purpose (a development page) and any port; everyone else only `EGRESS_ALLOWED_PORTS` (80, 443);
- tries the name's addresses in turn (IPv4 first; the next after 250 ms or as soon as one fails, like the browser does for itself) with an overall connect timeout, so one unreachable address cannot stall a page;
- caps open connections, idle time and the lifetime of each connection.

HTTPS and WebSocket go through as `CONNECT` tunnels. The proxy does not read or change the bytes, and Chromium still validates the certificate.

### The guard plugin (inside Prerender)

`lib/guard.js` runs for every tab:

- refuses a target that is not allowed (403), as the second line of defence;
- keeps the per-tab request filter (private addresses, local names, non-web schemes, optionally trackers/fonts/images);
- **switches certificate validation back on.** Prerender turns it off for every tab (`Security.setOverrideCertificateErrors({override:true})`
  and "continue" on every error), so a stock install renders pages behind expired, self-signed or wrong-host certificates. `ALLOW_INVALID_CERTS=true` restores that;
- dismisses JavaScript dialogs at once and denies downloads.

### The watchdog

Every `WATCHDOG_INTERVAL_MS` (5 s):

- closes tabs older than `TAB_MAX_AGE_MS` (a hung page, a pop-up, a crashed renderer), except the tab the browser starts with;
- asks the browser for its version through the DevTools port; after `BROWSER_PROBE_FAILURES` misses in a row it kills the browser (SIGKILL) and
  Prerender starts a new one. This catches a frozen browser, which Prerender cannot see: it only notices a closed connection;
- adds up the browser's memory (PSS, so shared pages are counted once) and recycles it above `BROWSER_MAX_RSS_MB`: when idle above the limit, at once above
  twice the limit, never more often than `BROWSER_RECYCLE_COOLDOWN_S`;
- exits the process if no browser has been connected for `BROWSER_DOWN_EXIT_S`, so the orchestrator restarts the container.

**During a browser restart** (crash, frozen browser, memory recycle) `/healthz` answers 503 and renders fail with 503 or 504 for a few seconds. A request that arrives in the moment
between the browser reporting ready and a fresh page being openable can fail once more. The caller's fallback (nginx's `error_page 500 502 503 504`) is what keeps crawlers from seeing an error.

### Memory

Prerender keeps the state of every finished request reachable for a long time (two timers it never cancels), about 4.5 MB per page. Memory is
therefore proportional to the request rate, and with a 384 MB heap the stock service ran out of memory after about 100 pages
(see the [test report](test-report.md)). `lib/release.js` hands that memory back as soon as the answer is built; `HEAP_SHED_PERCENT` turns a burst that would
still exhaust the heap into 503 answers instead of a crash.

### Shutdown

On SIGTERM the front server stops accepting, `/healthz` turns 503, running pages get up to `DRAIN_TIMEOUT_MS` to finish, then the browser is stopped and the process
exits with code 0 (1 if the drain timed out). `tini -g` is PID 1 and forwards the signal to the whole process group.

## Files

| File | Role |
| --- | --- |
| `server.js` | Reads settings, starts the egress proxy, Prerender, the front server and the watchdog; handles signals; process-level error policy |
| `lib/settings.js` | Every tuning number, with default, minimum and maximum; a bad value stops the start |
| `lib/guard.js` | `ALLOWED_HOSTS`, address classification, the Prerender plugin |
| `lib/front.js` | The public server |
| `lib/egress.js` | The proxy Chromium must use |
| `lib/watchdog.js` | Stale tabs, memory, frozen browser |
| `lib/release.js` | Early release of per-request memory |
| `scripts/smoke.sh` | Container checks run by CI on every build and on the published digest |
| `scripts/automerge*.js` | The auto-merge rules and runner, see [automerge-and-verification.md](automerge-and-verification.md) |
