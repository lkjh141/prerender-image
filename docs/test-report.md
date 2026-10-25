# Test report

This report says how the image was verified, what the tests found, what was fixed, and what is not covered. The tests are in `test/`, and every number below can be reproduced.
Numbers from a sandbox are marked as such. Where something was not explained, the report says so instead of guessing.

## Method

Each area was attacked first against the version of the image that existed before (or against stock Prerender 5.21.6), and the failure was kept as a test.
A fix counts only when that test passes afterwards. A test that has never failed proves little, so for the largest fix (the network-level SSRF protection) the fix was removed
again to show that the test fails without it. This is called a mutation check: with the proxy flags removed, 4 of 12 SSRF tests fail.

| Suite | Needs | What it does |
| --- | --- | --- |
| Unit: `guard`, `settings`, `egress`, `front`, `watchdog`, `release`, `automerge*` | nothing | Pure logic and the front server against a fake Prerender: validation, limits, queueing, deadlines, size cap, header and status filtering, address classification, rebinding sets, tunnelling, memory arithmetic, merge rules |
| `adversarial/ssrf` | Chromium | 12 ways for a rendered page to reach something private: fetch, image, form, redirect, cross-process frame, pop-up, WebSocket, WebRTC UDP, rebinding name, numeric spellings, DevTools port, `file:` |
| `adversarial/response` | Chromium | Header injection, forged status and headers, cookies, bad certificates, compression |
| `adversarial/input` | Chromium | Odd methods, malformed paths, hostile `/render` bodies, raw protocol abuse, slowloris, abandoned requests |
| `adversarial/exhaustion` | Chromium | 80 callers at once, pages that hang / spin / eat memory / trickle bytes, 5 MB DOMs, gzip bomb, endless body, 3000 fetches, pop-up and dialog loops, downloads, 150 frames |
| `adversarial/resilience` | Chromium | `SIGKILL` and `SIGSTOP` of the browser, browser killed under load, memory recycling, `SIGTERM` busy and idle |
| `adversarial/soak` | Chromium | 300 mixed renders (10 % hostile), before/after comparison of heap, memory, descriptors, processes, tabs and disk; opt-in latency benchmark |
| `bots/run.js`, `bots/tuning.js` | Chromium, nginx, Playwright | What 11 crawler and AI-bot user agents receive from a client-rendered demo site, with and without the service; speed against completeness |
| `scripts/smoke.sh` | Docker | The built image, read-only, no capabilities: renders, status tags, refusals, no internals in errors, non-root, healthy, clean stop |

Result of the last complete run on this branch: **102 tests, 101 passed, 0 failed, 1 skipped** (the opt-in benchmark). The same attack and exhaustion suites also pass against a
separately started service (`SERVICE_URL`), which is how CI runs them against the built container. The tests added by the security audit below came after that run, so the count above does not include them.

## What was found

"Stock" means unmodified Prerender 5.21.6, the version in the community images.

| # | Finding | Where | Evidence | Fix |
| --- | --- | --- | --- | --- |
| 1 | **Every TLS certificate is accepted** (expired, self-signed, wrong host). Prerender sets `Security.setOverrideCertificateErrors({override:true})` and continues on every error | stock | `response` test: a page behind a self-signed certificate was rendered and returned | Checking switched back on per tab; `ALLOW_INVALID_CERTS=true` opts out |
| 2 | **Four ways around a page-level SSRF filter**: a frame from another site (own process), WebSocket, WebRTC UDP, a public name that resolves to a private address | stock, and v1 of this image | `ssrf` tests 3, 5, 6, 7 failed; the private test service was contacted | Egress proxy for all browser traffic, name resolution and connection pinning in one place |
| 3 | **Stack traces and file paths in error pages** (`/<url>/%zz`, `POST /render {"url":123}`) | stock | Probe output showed `node_modules/…` and absolute paths | Prerender is loopback-only; the front server answers with fixed one-line texts |
| 4 | **`/render` API is open**: POST, JavaScript injected into the page, PDF and screenshot rendering | stock | `input` tests | Not exposed; only `GET /<url>` |
| 5 | **One request can end the whole process.** A page calling `alert()` in a loop makes Prerender ask the browser to close a dialog that is already gone; the rejected promise has no handler and Node exits | stock (latent) | Service died with `unhandled rejection: No dialog is showing`; further unhandled rejections (`WebSocket is not open`) appeared afterwards | Dialogs dismissed at once; unhandled rejections are logged and counted instead of fatal; uncaught exceptions still exit |
| 6 | **Memory grows with the request rate** until the process runs out of memory. Each finished request stays reachable for up to 60 s (a timer that is never cancelled holds the request, another holds the tab), about 4.5 MB per page | stock | With forced GC: 8 → 367 MB after 80 renders; the service with a 384 MB heap cap died after about 100 pages. After the load stopped the heap fell back to 9 MB, so it is a delay, not a permanent leak | `lib/release.js` hands the memory back when the answer is built (the same run stays at about 150 to 220 MB), and `HEAP_SHED_PERCENT` answers 503 before the heap is exhausted |
| 7 | **A frozen browser is never noticed** (only a closed connection is) | stock | `resilience`: after `SIGSTOP` every request hangs forever | Liveness probe through the debugging port kills the browser after 3 misses; replaced automatically |
| 8 | Headers from the rendered site are passed on, including `Set-Cookie`; a page can pick any status including 204/304 | stock | `response` tests | Header allowlist; status filter |
| 9 | **404 pages keep their application scripts.** `httpHeaders` ends the plugin chain for any status other than 200, so `removeScriptTags`, registered after it as in the community image, never runs | stock plugin order | Bot test: scripts left on 2 of 7 pages | Script removal registered first |
| 10 | No limits: concurrency, queue, deadline, response size, connections, tabs | stock | `exhaustion` | Settings with defaults, minimums and maximums |
| 11 | Pop-ups and stuck tabs are never closed | stock | `exhaustion` | `--block-new-web-contents`, watchdog |
| 12 | The browser profile directory was a fixed path, so two instances on one machine fought over the profile lock | v1 of this image | Start failure in the lab | `CHROME_PROFILE_DIR` |

Defects in the new code, found by the same tests and fixed before they could ship:

| # | Defect | Found by | Fix |
| --- | --- | --- | --- |
| a | The egress proxy added a `close` listener on every request over a keep-alive connection (`MaxListenersExceededWarning`) | log of a frame-heavy page | Track each socket once |
| b | The watchdog could restart a browser that was still starting; Prerender then treats a restart within 1 s as "the browser keeps dying" and stops the service | memory-recycling test | No action on a browser that is not connected; cooldown between recycles |
| c | The memory limit added up resident sizes of Chromium's processes, which count shared pages several times (a fresh idle browser read as 945 MB) | same test | Proportional size (PSS), read only for the browser's processes |
| d | An undecodable percent-escape that passed the first version of the path checks still reached Prerender and returned a stack trace | probe after the front server existed | The front server decodes the path itself and refuses it |
| e | Auto-merge: workflow and runner reviewed for trusting the wrong thing | design review | Check accepted only from the `github-actions` app; Dependabot commits and files verified; merge pinned to the checked commit |
| g | The egress proxy connected to only the first address a name resolved to and had no connect timeout, so one unreachable address (dead node in a round-robin name, unroutable IPv6) could stall a request until the page gave up. Seen as an intermittent ~10 s render (the page-load timeout) on the first canary against a real production site; the demo site used by the suites had no such host | canary on the StageRage server | Addresses are tried in turn, IPv4 first, the next after 250 ms or at once on failure, with `EGRESS_CONNECT_TIMEOUT_MS`; unit tests including an end-to-end CONNECT with a dead first address (fails without the fix) |
| h | Every render of a page with a CAPTCHA widget (Turnstile) ended at the page-load timeout, and the first canary showed the old image caching renders in memory while this one did not (so every crawler hit cost a render) | canary on the StageRage server | The timeout is the page's own behaviour (the old image waited its full 20 s); the image has an optional render cache that keeps only clean 200 renders (`CACHE_TTL_S`); unit tests for the cache and the front server, and a real-browser suite that proves a clean page is served from the cache and a timed-out, failing or non-200 page is not |
| f | CodeQL: an over-broad regular expression character range in the CONNECT parser; test helper with certificate checking off and an unchecked dynamic call | code scanning on the PR | Simplified, removed, checked |

Test-harness mistakes that looked like product problems and were corrected: a benchmark that drew from the hostile mix (it reported 3 s outliers that were the suite's own deliberately hanging page), a soak threshold on an unforced-GC heap, a text comparison that glued navigation links together, and a skipped test caused by an empty `skip` string.

## Security audit

A later review went through the address classification, the egress rules and the cache with the aim of finding ways around them. It produced two real findings and one
check that found nothing. The findings are written as the problem, the evidence and the fix, in the same way as the table above.

**Finding: IPv6 addresses in unusual forms were not all recognised as private.** An IPv6 address can carry an IPv4 address inside it, and it can be written in several
spellings. Some forms were not classified by the address they stand for, so an address that points at a private IPv4 host could be judged public. The forms checked were
the expanded IPv4-mapped form, NAT64, 6to4, site-local, Teredo and the documentation ranges. All of them are now recognised as not public. The classifier was checked against Node's
own `net.BlockList` with 200,000 random addresses, with 0 differences. The new test is `test/ipclassify.test.js`. It also checks that real public addresses, including public
IPv4 addresses inside IPv6 forms, are still allowed, and that anything that is not an address at all is refused instead of allowed.

**Finding: a listed host that resolves to a public address could use any port.** A host in `ALLOWED_HOSTS` is trusted to be a private development page if it resolves to a private
address, and then any port is allowed (except the service's own). The same freedom also applied when a listed name resolved to a public address. A listed name that pointed at
the server's own public address could then have been used to reach other services on that address, such as SSH. Such a host is now limited to `EGRESS_ALLOWED_PORTS` (default 80
and 443). The test is in `test/egress.test.js` (`only the listed ports are open, for listed hosts too unless they resolve to a private address`).

**Check with no flaw found: a page forging the prerender headers.** A page can set response headers with `<meta name="prerender-header">`. The audit tried to make a page that
never finishes look complete and cacheable by setting `x-prerender-complete`, a long `cache-control` and `x-prerender-cache: hit` that way. The incomplete render was not kept: the
cache header in the answer came from the service, the completeness marker was not passed on, and a second request rendered the page again. No flaw was found. The test is in
`test/adversarial/cache.test.js` (`a page cannot forge the completeness marker or the cache headers with prerender-header tags`) and stays as a guard.

**Check: host confusion in the request path.** `test/adversarial/urlparse.test.js` sends 53 spellings of a target URL as the path of a render request (credentials before
the host, backslashes, encoded separators, numeric, octal and hexadecimal hosts, ideographic dots, soft hyphens, full-width digits, IPv4-mapped, NAT64 and 6to4 forms, other schemes, injected
line breaks). The allowed site is `127.0.0.1` and a second "private service" listens on `127.0.0.2`. The test fails if the private service is contacted at all, or if any request
goes unanswered. Result: the private service was never contacted and every request got an answer. The allowed site does receive some odd paths (text after the host that the URL parser reads
as a path), which is harmless because those requests still go to the allowed host. No flaw was found.

**Finding: a burst of callers for one uncached page rendered it once per caller.** With the cache on, 12 simultaneous requests for the same new page took 12 browser renders
(12 requests to the site, 5.1 s with 2 slots), so one crawler burst or a cold start filled every slot with identical work. Now the first caller renders and the others wait for it
and are served from the cache: 1 request to the site and 0.8 s for the same 12 callers. If the first render cannot be kept (a timeout, an error), the waiting callers render
on their own, so a page that cannot be cached behaves as before. Callers that leave while waiting are dropped without a leak. The tests are in `test/adversarial/cache.test.js`
(three tests starting with `a burst of callers`, `a burst for a page that cannot be kept` and `callers that leave while waiting`), and the new counter is `prerender_coalesced_total`.

**Measured on the sandbox after these changes.** Cached answers: 20,000 requests at 64 connections in 2.3 s (about 8,700 per second, measured with a Node client that was itself the limit),
p50 6.3 ms, p99 22 ms, no wrong answers. During a flood of 200 different new URLs, `/healthz` still answered in 0.6 ms, 36 renders finished and 164 requests were turned away with 503
at once. The full suite, with the browser suites, ran 156 tests (176 after the TLS and nginx suites were added): 155 passed, 0 failed, 1 skipped (a test that needs the container).

**Finding on the live server: repeated log lines from the browser itself.** The audit script run on the production server found 56 `egress blocked (port)` lines in 2,000 log lines, all for
`mtalk.google.com:5228`. That is Chromium's own push-messaging connection, which the egress proxy rightly refuses because port 5228 is not allowed. It does no harm, but it hides real
refusals in the log. The same behaviour was reproduced in the sandbox. Four ways to stop the browser trying were tested (disabling the `GCM`, `PushMessaging` and `GCMDriver` features
and `--disable-push-api` had no effect; pointing `--gcm-mcs-endpoint` at a loopback address stopped the log lines but made the browser connect straight to that loopback port, which
bypasses the egress proxy, so it was rejected). Instead the egress proxy now writes the same refusal at most once a minute, with the number of repeats it stood for. The metrics still count every
refusal. The test is in `test/egress.test.js`.

**Not a flaw, but worth knowing.** `/metrics` (when `METRICS_ENABLED=true`) is served on the same port as the renders. Keep that port on `127.0.0.1` or block `/metrics` in the web
server, so that only the monitoring system can read it.

## Gaps closed after the audit: TLS, nginx, DNS rebinding and a long soak

The audit report listed four things it had not tested. They were tested on 2026-10-25.

**TLS against many kinds of server** (`test/adversarial/tls.test.js`, 14 tests). A throw-away certificate authority is created and trusted by the browser in a private certificate store (a temporary `HOME`), so each
defect can be tested alone. A good chain must render, and everything Chromium should reject must not return the page it served.

| Server | Result |
| --- | --- |
| Trusted chain; trusted chain through an intermediate that the server sends; HTTP/2; TLS 1.2 only; TLS 1.3 only | rendered (200) |
| Expired; not yet valid; certificate for another name; self-signed; chain from an authority that is not trusted; intermediate missing from the chain; TLS 1.0 only; TLS 1.1 only | refused, page not returned |

The first group is the control: if the trust store did not work, every row would be refused. A run against the public `badssl.com` test hosts was also tried and is not used as evidence: the sandbox network re-signs
HTTPS traffic with its own gateway certificate and answers some hosts itself, so those results do not show what the service does. One thing it did show, which is also true of ordinary Chrome: a revoked certificate is
accepted (Chromium does not check revocation online), and so is a "pinning" test host. The service adds no revocation check.

**nginx in front** (`test/adversarial/nginx.test.js`, 5 tests, skipped when nginx is not installed). A real nginx runs the logic of `docs/nginx.example.conf` (plain http and local ports instead of the public address).
A crawler gets the rendered page and a visitor gets the app shell. Query strings reach the page. A file with an extension is served as a file. A request from the service's own browser (user agent with "Prerender") gets the shell
instead of another render. Twelve odd request targets (absolute-form URL, userinfo, double slash, encoded `@`, backslash, `..%2f`, injected line breaks, a fragment, `*`) and spoofed `Host`, `X-Forwarded-Host`, a second `Host` header
and a trailing-dot host never reached the private test service, and the site only received the paths nginx should produce. When the service is down, crawlers still get the app shell.

**Public DNS rebinding** (`test/manual/dns-rebinding.js`, needs root). A real DNS server answers names under `rebind.test` with a public address and a private one in turn (time to live 0). An allowed page asks for 12 such names, 6 times
each, as fetches and as images. In all three orders (public first, private first, private both times) the private web server received 0 requests over about 40 changing answers each. The egress proxy resolves a name once, refuses
it if any answer is private, and connects to the address it checked, so the second answer is never seen. It is a manual script, because it listens on UDP port 53 and rewrites `/etc/resolv.conf` for the duration.

**A long soak under the burst and cache code** (`test/manual/burst-soak.js`, `SOAK_MINUTES`, default 30). The cache is on with a small limit so it keeps evicting. Each round has a burst of 16 callers for one new page, 24 mixed requests
(including pages that alert, open pop-ups, poll forever or never finish) and 40 repeat requests. The first run lasted 30 minutes: 12,562 requests, all answered 200, 0 wrong answers, 0 server errors, 157 bursts and each burst asked
the site exactly once, 8,583 answers from the cache, and nothing left in flight or queued afterwards. After the first minute of warm-up, service memory stayed at 265 to 280 MB, file descriptors at 72 to 75, browser processes at 6 to 10, tabs
at 0 or 2, the browser profile at 8 MB and the cache at its 40-entry limit. Between the first and second halves: service +5 MB, heap -8 MB, browser -53 MB, descriptors -2, processes -2. The script reported one problem, service memory
86 MB against 277 MB, but its baseline had been taken after only two requests, before the heap and cache filled; the measurement was wrong, not the service. The baseline is now taken after the first minute of load, and a second 12-minute run with the corrected script ended with `SOAK OK`: 5,042 requests, all 200, 0 wrong answers, 63 bursts each asking the site once, 1,764 callers that waited for a first render
(`prerender_coalesced_total`), service memory 271 to 281 MB (+6 MB between the halves), descriptors 73 to 72, and nothing in flight afterwards.
A 30-minute run is not a multi-hour run. A 60-minute run was then done on the server, in a separate container (see "Audit on the live server").

**What this did not cover.** Cloudflare itself cannot be reached from the sandbox. `scripts/server-audit.sh` therefore has a read-only section that sends crawler and odd-path requests through the real public path of the server.

## Audit on the live server

`scripts/server-audit.sh` (see [server-audit.md](server-audit.md)) was run on the production server: Ubuntu, 4 vCPU, 8 GB, with ufw allowing ports 80 and 443 only from Cloudflare and
localhost, and redis and mongodb on loopback. The production container was only inspected. All attacks and load ran in throw-away `pt-*` containers (2 CPUs, 1 GB, port 3902) that were
removed afterwards. The run was done twice, on 2026-10-25: first against the image production was running (`sha256:8df698f3…`, before the audit fixes), then against the image built from
the audit fixes (`sha256:c56d20c8…`). Neither run had a FAIL line.

| Check | Image before the fixes | Image with the fixes |
| --- | --- | --- |
| Production container hardening (unprivileged user, read-only root, no capabilities, no new privileges, memory and pids limits, published on `127.0.0.1` only, 0 restarts) | all PASS | all PASS (same container) |
| 12 attack requests (host not allowed, private and loopback literals, IPv4-mapped metadata address, user-info trick, `file:`, bad escape, control character, POST, long URL, error-page leaks, version headers) | all refused as expected | all refused as expected |
| Hostile page trying to reach a private "secret" service by `fetch`, image, WebSocket, metadata address and numeric and IPv6 spellings | page rendered, secret service contacted 0 times | page rendered, secret service contacted 0 times |
| Cold render of the real site (132,074 bytes) | 2.42 s | 2.52 s |
| Cached answer of the same page | 2.8 ms | 1.9 ms |
| 12 simultaneous callers for one new page | 12.6 s | 2.5 s, 11 of them waited for the first render (`prerender_coalesced_total` 11) |
| 300 cached answers one after another (includes the start-up of each `curl`) | 2.93 s | 2.98 s |
| Test container after the load | 1.9% CPU, 252 MiB, 99 pids | 1.9% CPU, 215 MiB, 112 pids |
| Health after the load, slots left taken, production restarts during the audit | 200, 0, 0 | 200, 0, 0 |

What the live runs showed beyond the sandbox:

- **The burst flaw was real on the live server.** With the old image, 12 callers for one new page took 12.6 s because each one rendered the page. With the fix the same burst took 2.5 s,
  about one render, and 11 callers were served after waiting for it.
- **Chromium's own refusals fill the log.** The production log held 56 (first run) and 81 (second run) `egress blocked (port)` lines in 2,000 lines, all for `mtalk.google.com:5228`,
  Chromium's push-messaging connection. Refusing it is correct. See the finding above: four browser flags were tested in the sandbox and none was safe to ship, so the egress proxy now
  logs the same refusal once a minute with a repeat count.
- **Production metrics were healthy.** After about a day on the image: 0 timeouts, 0 refused, 0 queue-full, 0 memory shedding, cache hits 14 of 33 lookups, 16 entries (1.6 MB), 150 MiB of
  the 2 GiB limit, 16 orphan write-offs in the log (the fix for requests that a self-reloading page leaves unreported, working as intended).

**Third run, the final image, and a 60-minute soak (2026-10-25).** After the audit fixes and the quieter refusal log were merged, the script was run again against the published image `sha256:a4b53eac…`, followed by
`scripts/server-soak.js` for 60 minutes in a separate container with the production limits (2 GB, 2 CPUs, 512 processes, read-only root, no capabilities, no published ports; see [server-audit.md](server-audit.md#long-soak-on-the-server)).
The public-path section of the audit script was left out of this run, so that nothing reached the production container. Neither run had a FAIL line or a problem.

| Check | Result |
| --- | --- |
| Production hardening, restarts during the audit, health before and after | all PASS, 0 restarts, healthy |
| 12 attack requests; hostile page against the private "secret" service | all refused as expected; the secret service was contacted 0 times |
| Cold render of the real site (132,074 bytes) / cached answer | 2.43 s / 3.0 ms |
| 12 simultaneous callers for one new page | 2.3 s, 11 coalesced (the old image: 12.6 s) |
| 300 cached answers one after another (includes the start-up of each `curl`) | 2.90 s (9.7 ms each) |
| Test container after the load | 2.5% CPU, 213 MiB, 109 pids |
| Production metrics at the time | 400 requests, 23 rendered, 33 cache hits and 23 misses, 0 timeouts, 0 refused, 0 queue-full, 0 memory shedding, 160 MiB of the 2 GiB limit |

The 60-minute soak (rounds of a burst of 16 callers for one new page, 24 mixed requests including alert, pop-up, endless polling and never-finishing pages, and 40 cached repeats, with a small cache that keeps evicting):

| | |
| --- | --- |
| Requests | 10,802 in 61 minutes (135 rounds): 10,802 answered 200, 0 wrong, 0 server errors, 0 with no answer, 0 timeouts, 0 queue-full |
| Bursts | every burst of 16 callers cost the synthetic site exactly one request; 4,677 callers waited for a first render; 7,357 answers came from the cache |
| Service memory | 192 MB after the first minute of load, 202 to 210 MB for the rest, 208 MB at the end (+0 MB between the first and second half) |
| Browser memory | 516 to 884 MB, 598 to 611 MB at the end (-70 MB between the halves); the service plus the browser peaked near 1.1 GB, inside the 2 GB limit |
| File descriptors, threads, processes | 26 to 46 (29 at the end), 11 throughout, 7 to 11; none grew |
| Left behind at the end | nothing in flight, nothing queued, no tabs open, cache at its 40-entry limit |

One observation on the production log: 186 of its last 2,000 lines were `egress blocked (port)` lines for `mtalk.google.com:5228` (Chromium's own push-messaging connection). Production was still running the image from before the quieter log,
which writes the same refusal at most once a minute.

Not covered by the script, by design: anything that would change or restart the production container, and the checks that need the container's process or debugging port.

## Measured results

4-core sandbox, Chromium 141 (Playwright's build; the Alpine image uses Alpine's), Node 22. Latency is wall clock from the caller.

**Latency and throughput** (`BENCH=1`, demo pages, p50 / p95 / p99 in ms):

| concurrency | simple page | SPA page | heavy page (3000 nodes) | pages/s |
| --- | --- | --- | --- | --- |
| 1 | 766 / 822 / 842 | 759 / 792 / 818 | 760 / 802 / 822 | 1.3 |
| 2 | 881 / 981 / 1006 | 891 / 974 / 1040 | 899 / 974 / 1298 | 2.2 |
| 4 | 1098 / 1247 / 1274 | 1141 / 1199 / 1249 | 1169 / 1296 / 1387 | 3.5 |

The tail is tight (p99 within about 10 % of p50 at concurrency 1). About 0.5 s of each page is the quiet period Prerender waits for after the last request, which is why simple, SPA and heavy pages cost almost the same.

**Resources** (demo site, 30 uncached renders): 0.85 s median, 1.26 s p95, 0.33 CPU-seconds per page, browser peak 421 MB, service 198 MB. From a cache: 0 to 1 ms.
Soak: 300 renders in about 90 to 112 s (2.7 to 3.3 per second including hostile pages); heap 159 → 153 MB, file descriptors 47 → 29, one browser, profile disk +4 MB, 0 of 270 normal pages failed.

**Output quality** (`bots/run.js`; 11 bot user agents × 7 pages, compared with the settled DOM a real browser shows):

| | without the service | with the service |
| --- | --- | --- |
| Content a person sees that the bot also gets | 0 % | 100 % |
| `<title>`, description, canonical, `og:title`, `<h1>` present | 0 % | 100 % |
| Valid JSON-LD on the product page | 0 % | 100 % |
| Internal links on the home page | 0 | 5 of 5 |
| Missing pages answered with 404 | 0 % | 100 % |
| Application scripts left in the page | 1 | 0 |

**Speed against completeness** (`bots/tuning.js`, 12 renders per cell): content that appears after 500 ms or more with no network activity is not waited for at any setting
(0 of 12 at the default); with `window.prerenderReady` it is 12 of 12 at every setting, from 100 ms to 500 ms. With the signal set, the quiet period can be lowered to 200 ms safely. Stock
polling every 500 ms captured the late content by luck of timing (12 of 12), which is not something to rely on, so the default polls every 100 ms and the signal is the documented answer.

## Measured on a real production site

The suites above use a demo site, and a demo site cannot show how a real application behaves. This section is a canary: the image run on a real server against a real single-page app,
on 2026-10-24 and 2026-10-25.

| | |
|---|---|
| Server | 4 vCPU, 8 GB RAM, Ubuntu, Docker |
| Container | `--memory 2g`, `--pids-limit 512`, read-only root with a 512 MB `/tmp`, all capabilities dropped, `no-new-privileges` |
| Settings | defaults (`MAX_CONCURRENCY=4`), except `PAGE_LOAD_TIMEOUT_MS=10000`, `REQUEST_TIMEOUT_MS=14000`, `DIAGNOSTICS=true`, `LOG_REQUESTS=true` |
| Browser | Chromium 142 (Alpine) |
| Site | a React single-page app behind Cloudflare that loads web fonts, an error-reporting library (Sentry) and a Cloudflare Turnstile widget on one page, and reloads itself about one second after it first loads |
| Caller | `curl` on the same server, so the figures are the service's own time; the network to the caller is not in them |
| Compared with | the community image this one replaces (`tvanro/prerender-alpine`), running on the same server |

**Home page, one render after another** (each row is a separate container started fresh):

| image | renders | reached the 10 s page-load timeout | fastest | mean | slowest |
|---|---|---|---|---|---|
| this image, before the fix below, run 1 | 20 | 12 | 1.8 s | not meaningful | 10.4 s |
| this image, before the fix below, run 2 (fresh container) | 20 | 9 | 1.8 s | not meaningful | 10.2 s |
| this image, before the fix, in-page request filter off (`PAGE_FILTER=false`) | 20 | 11 | 1.8 s | not meaningful | 12.3 s |
| this image, with the fix (`lib/orphans.js`) | 20 | **0** | 1.75 s | **2.0 s** | 2.35 s |
| 10 pairs, one after the other: this image | 10 | 0 | 1.78 s | 2.12 s | 2.95 s |
| 10 pairs, one after the other: the community image | 10 | 0 | 1.77 s | 1.83 s | 1.88 s |

With the fix the image is about 0.3 s slower than the community image on an uncached page. The extra time is the quiet period plus the 750 ms (`NAVIGATION_SETTLE_MS`) that
a request of an old page is given to report back, which only applies when one did not.

**Several pages, 4 renders at the same time:**

| test | result |
|---|---|
| 5 page types (home, venue, news, toolkit, game), 8 rounds, 4 at a time: 40 renders | 39 answered 200, the slowest in 3.7 s; 1 answered 504 (the home page reached the page-load timeout with one request still counted, then the 14 s request limit) |
| The same 5 pages, one render each, one after the other | 1.9 to 2.1 s |
| Home page 24 times, 4 at a time | 0 timeouts, all 200, slowest 5.7 s |
| Home page 14 times (6 one after the other, 8 four at a time) | all 132074 bytes, no difference between any two |
| 30 pages from the sitemap, twice, 4 at a time (60 renders) | 58 under 4.1 s; the contact page 10.3 s both times (see below) |

Output size per page was the same on every repeat: home 132074 bytes, venue 145083, news 94282, toolkit 97698, game 97850. One run of the 24 renders showed two smaller home pages
(129016 and 131816 bytes); they were not seen again in 14 later renders and were not explained.

**With the render cache** (`CACHE_TTL_S=3600`, image digest `sha256:dcab46ff...`, fresh container, `DIAGNOSTICS=true`):

| test | result |
|---|---|
| Six pages (home, venue, news, toolkit, game, contact), three passes one after another | pass 1: all `miss`, 1.96 to 2.78 s, and the contact page 10.2 s. Passes 2 and 3: the five ordinary pages are all `hit`, 1.4 to 3.4 ms, with exactly the bytes of the first render (132074, 145083, 94282, 97698, 97850); the contact page is `miss` at 10.2 s every time, because it never finishes cleanly and is never kept |
| 30 pages from the sitemap, 4 at a time, twice | round 1: 29 of 30 under 4.5 s, the contact page 10.3 s; round 2: 29 hits, each under 6 ms, the contact page 10.2 s; 0 answers other than 200 |
| Cache after those runs | 41 hits, 37 misses, 32 pages stored, 3.6 MB (about 110 KB a page), 0 evictions |
| `page timed out` in the log | 5, all of them the contact page |
| Requests written off after a self-reload (`wrote off`) | 30 lines; every render that needed it finished cleanly |
| Container restart | the first request after it `miss`, the second `hit`: a restart empties the cache, which is how a deploy flushes it |
| Memory | 335 MiB of 2 GiB, 101 processes, 2.5 % CPU when sampled |
| The 504 seen earlier | not seen in about 80 renders of this build |

**Compared with the community image it replaces:** the home and news pages were byte for byte the same on both; the venue page had the same size and differed only in where one
`<link rel="modulepreload">` sits in the head (the browser adds it when the script is requested, so its position follows timing).

**In production:** the image was started under the old container's name and port (the old container stopped and renamed, kept for rollback), and the site's own crawler check, `check-prerender.sh`
through nginx as Googlebot (title, content, canonical, `og:url`, robots tag, sitemap type), passed. Settings used: `ALLOWED_HOSTS` for the site's two host names, `PAGE_LOAD_TIMEOUT_MS=10000`,
`REQUEST_TIMEOUT_MS=14000`, `CACHE_TTL_S=3600`, `--memory 2g`, read-only root, all capabilities dropped.

**Resources:** after about 110 renders the container used 337 MiB of its 2 GiB (333 MiB after the first 60), 108 processes, and 2.3 to 2.6 % CPU when sampled right after a run.

**What this run found**

1. **Requests of an old page that never report back.** On the first canary about half of the renders ended at the 10 s page-load timeout, with the right content, where the
   community image took about 1.8 s. The page reloads itself, and the request left open at the timeout was, in 8 of 9 slow renders with the filter on, the error-reporting library's final
   beacon (the others: a script bundle, and with the filter off up to six API calls). Chromium never reported those requests as finished or failed, so Prerender waited for them. It was not
   the in-page request filter (about the same with it off), and not the proxy connecting (every tunnel opened in 5 to 7 ms, none failed, no request stayed paused). It was not reproduced with a
   local test page in 100+ renders. Fixed by `lib/orphans.js`: after the page starts a new document, requests of the old document get `NAVIGATION_SETTLE_MS` to report back and are then
   written off. Result: 0 of 20 slow, and the fix fired in 14 of those 20 renders.
2. **A page with a widget that never finishes.** The contact page (Cloudflare Turnstile) is not finished from Prerender's point of view, because the widget keeps connections open.
   It takes the full page-load timeout: 10.2 s with this image (10 s limit) and 20.2 s with the community image (its 20 s limit). This is a historical finding about one site's page
   and is not a setting problem in the image. The site-side fix is `window.prerenderReady`.
3. **One 504 on the home page in about 100 renders under load**, not reproduced in 38 more, nor in about 80 renders of the build with the cache. The log showed a page-load timeout with one request still counted. Its cause is not known; the web server's fallback to the normal app covers a request like it. Watch `prerender_timeouts_total` in production.

## Not covered

- The Docker image was not built or run in the sandbox where the suites were developed (no container runtime there). CI builds it, smoke-tests it, runs the attack and exhaustion suites against the container, and scans it. The operator should read the results of the CI run on the commit being deployed.
- Alpine's Chromium is not the Chromium used here; flags and behaviour were checked against the protocol, not against that build, except by CI.
- Linux only. No Windows or macOS host, no IPv6-only network, no Kubernetes run (the manifest is an example).
- No multi-hour soak and no tests with real third-party pages; the demo site is small by design.
- Real crawlers were not contacted. The bot test sends their user-agent strings through the same nginx rule real crawlers hit; it does not test how any crawler processes the answer.
- A browser zero-day is out of scope for any test. See the [threat model](threat-model.md).
