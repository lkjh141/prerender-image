# Architecture

This page describes how the service is put together, why each part exists, and what each part does when something goes wrong. The settings named
here are explained in [configuration](configuration.md). The attacks the design answers are in the [threat model](threat-model.md).

## The pieces

```
                      public port (PORT, default 3000)
 the web server ────────────────┐
                                ▼
                     ┌─────────────────────┐   loopback only    ┌──────────────────────┐
                     │  front server       │ ─────────────────► │  Prerender 5.21.6    │
                     │  lib/front.js       │                    │  (Express + CDP)     │
                     └─────────────────────┘                    └──────────┬───────────┘
                       validates, limits,                                  │ DevTools protocol
                       queues, filters the                                 │ (loopback)
                       answer                                              ▼
                                                                ┌──────────────────────┐
   the site ◄───── egress proxy (lib/egress.js) ◄────────────── │  Chromium (headless) │
   (and what it         resolves names, refuses private         │  one browser context │
    loads)              addresses, pins the connection          │  per request         │
                                                                └──────────────────────┘
                     watchdog (lib/watchdog.js): stale tabs, memory, frozen browser
                     release plugin (lib/release.js): hands request memory back early
                     guard plugin (lib/guard.js): allowlist, strict TLS, dialogs, downloads
```

Everything runs in one container and one Node process, except Chromium and its helpers. `server.js` wires the parts together.

Reading the diagram from top to bottom: a request comes in on the public port and meets the front server. The front server checks it and passes it to Prerender,
which is only reachable from inside the container. Prerender drives Chromium over the DevTools protocol. Chromium loads the page, and every network connection
it opens has to go through the egress proxy. The answer travels back up the same path, and the front server cleans it before sending it out.

### Why a front server

Prerender is an Express app that starts listening by itself and exposes no hook for limits, error pages or health checks. It answers a
malformed percent-escape with a page that shows a stack trace and file paths, and its `/render` API accepts JavaScript to run in the page.
So Prerender is started on a loopback port that nothing outside the container can reach, and a small server written for this image is the only public
listener. That server is small enough to reason about and test (`test/front.test.js`), which is the reason it sits in front instead of patching Prerender's own server.

What the front server does, in order:

1. Accepts only `GET /<http or https URL>` (and `HEAD`, which gets the same status and headers with no body and costs the same render), plus `/healthz` (and `/metrics` if enabled). Every other method gets 405 with `Allow: GET, HEAD`, every other path 404 or 400.
   The `/render` API is not reachable.
2. Rejects control characters, undecodable escapes and over-long paths, with fixed one-line texts.
3. Computes the target URL **with Prerender's own function** and checks it against `ALLOWED_HOSTS` (403). Using Prerender's function matters: if the
   front server parsed the URL differently, the allowlist check and the browser could disagree about which host is meant. The same check runs again inside
   Prerender, as a plugin, on the URL it will really fetch.
4. Admits the request: `MAX_CONCURRENCY` render at once, `MAX_QUEUE` wait up to `QUEUE_TIMEOUT_MS`, the rest get 503 immediately. A client that
   leaves while waiting gives its place up. New work is also refused while the heap is nearly full (`HEAP_SHED_PERCENT`) and while draining.
5. Forwards to Prerender, with a hard deadline (`REQUEST_TIMEOUT_MS`) and a cap on the size of the answer (`MAX_RESPONSE_BYTES`).
6. Builds the answer: only a short list of headers is passed on (no cookies, no security headers from the rendered site), status codes
   204/205/304 and anything outside 200 to 599 become 502, a `Location` must be http, https or a path, the body is always sent as
   `text/html; charset=utf-8`, and the service adds its own `nosniff`, `Referrer-Policy` and a restrictive `Content-Security-Policy`.

The reason for step 6 is that the rendered page is untrusted. Whatever headers and status it asks for are only requests. The front server decides what is
safe to pass to the caller.

If the render cache is on (`CACHE_TTL_S`), it sits between steps 3 and 4. A request for a page that is already stored is answered from memory after the
URL and host checks, and takes no render slot. The cache is described in [configuration](configuration.md#render-cache-optional-off-by-default).

### The egress proxy

A page-level filter (intercepting requests in the tab) cannot see everything a browser opens: frames that run in a different process, WebSocket
connections, WebRTC, and DNS names that resolve to private addresses all get past it. Those four paths were reproduced against the first version of this
image (`test/adversarial/ssrf.test.js`, see the [test report](test-report.md)). The fix is at the network level: Chromium is started with
`--proxy-server` pointing at an in-process proxy, `--proxy-bypass-list=<-loopback>` (so even loopback goes through it) and
`--host-resolver-rules=MAP * ~NOTFOUND` (the browser resolves nothing itself).

The effect is that the browser has no way to open a connection that the proxy does not see. It cannot look up a name on its own, and it is not allowed to
skip the proxy for local addresses.

For every connection the proxy:

- resolves the name itself and refuses the connection if **any** returned address is private, loopback, link-local, multicast or otherwise not public.
  The check classifies IPv6 addresses by what they stand for, so an IPv4 address wrapped in IPv6 (IPv4-mapped, NAT64, 6to4 and similar forms) is judged as the IPv4 address inside it;
- connects to the exact address it checked, so the browser never gets a second resolution to race (DNS rebinding);
- never lets a page reach the service's own ports (public, Prerender, DevTools, the proxy), even if a loopback host is in `ALLOWED_HOSTS`;
- lets hosts listed in `ALLOWED_HOSTS` be private on purpose (a development page) and use any port; everyone else only `EGRESS_ALLOWED_PORTS` (80, 443).
  A listed host that resolves to a private address may use any port except the service's own. A listed host that resolves to a public address keeps to `EGRESS_ALLOWED_PORTS`;
- tries the name's addresses in turn (IPv4 first; the next after 250 ms or as soon as one fails, like the browser does for itself) with an overall connect timeout, so one unreachable address cannot stall a page;
- caps open connections, idle time and the lifetime of each connection.

HTTPS and WebSocket go through as `CONNECT` tunnels. The proxy does not read or change the bytes, and Chromium still validates the certificate.

### The guard plugin (inside Prerender)

`lib/guard.js` runs for every tab:

- refuses a target that is not allowed (403), as the second line of defence;
- keeps the per-tab request filter (private addresses, local names, non-web schemes, optionally trackers/fonts/images). `PAGE_FILTER=false` removes this layer only;
  the egress proxy still enforces the network rules;
- **switches certificate validation back on.** Prerender turns it off for every tab (`Security.setOverrideCertificateErrors({override:true})`
  and "continue" on every error), so a stock install renders pages behind expired, self-signed or wrong-host certificates. `ALLOW_INVALID_CERTS=true` restores that;
- dismisses JavaScript dialogs at once and denies downloads.

### The release plugin and the orphan sweep

`lib/release.js` does two jobs. It hands per-request memory back as soon as the answer is built (see Memory below), and it marks each render as clean or not clean.
A render is clean when it finished without a page-load timeout, without a 5xx answer to one of the page's own requests, and without a browser error. The mark is an internal header that the front server
reads and removes. The render cache keeps only clean renders.

`lib/orphans.js` handles a page that navigates itself, for example a script that reloads the page about a second after it first loads. Chromium sometimes never
reports a request that was started just before such a navigation as finished or failed. Prerender counts that request as still open and waits for it until the page-load
timeout. The orphan sweep gives requests of the old document `NAVIGATION_SETTLE_MS` to report back and then writes them off. The
[test report](test-report.md#measured-on-a-real-production-site) has the measurements that led to it.

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
exits with code 0 (1 if the drain timed out). `tini -g` is PID 1 and forwards the signal to the whole process group, so Chromium and its helpers hear the signal too.

## Files

| File | Role |
| --- | --- |
| `server.js` | Reads settings, starts the egress proxy, Prerender, the front server and the watchdog; handles signals; process-level error policy |
| `lib/settings.js` | Every tuning number, with default, minimum and maximum; a bad value stops the start |
| `lib/guard.js` | `ALLOWED_HOSTS`, address classification, the Prerender plugin |
| `lib/front.js` | The public server |
| `lib/egress.js` | The proxy Chromium must use |
| `lib/watchdog.js` | Stale tabs, memory, frozen browser |
| `lib/release.js` | Early release of per-request memory; marks whether a render finished cleanly |
| `lib/orphans.js` | Writes off requests of an old document that a self-navigating page leaves unreported |
| `lib/cache.js` | The optional in-memory cache of finished renders (used by `lib/front.js`) |
| `scripts/smoke.sh` | Container checks run by CI on every build and on the published digest |
| `scripts/automerge*.js` | The auto-merge rules and runner, see [automerge-and-verification.md](automerge-and-verification.md) |
