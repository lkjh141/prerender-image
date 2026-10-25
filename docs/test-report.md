# Test report

How this image was verified, what the tests found, what was fixed, and what is not covered. The tests are in `test/`; every number below can be reproduced.

## Method

Each area was attacked first against the version of the image that existed before (or against stock Prerender 5.21.6), and the failure was kept as a test.
A fix counts only when that test passes afterwards, and for the largest one (the network-level SSRF protection) the fix was removed again to show that the
test fails without it ("mutation check": with the proxy flags removed, 4 of 12 SSRF tests fail).

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
separately started service (`SERVICE_URL`), which is how CI runs them against the built container.

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
| d | An undecodable percent-escape that passed my own checks still reached Prerender and returned a stack trace | probe after the front server existed | The front server decodes the path itself and refuses it |
| e | Auto-merge: workflow and runner reviewed for trusting the wrong thing | design review | Check accepted only from the `github-actions` app; Dependabot commits and files verified; merge pinned to the checked commit |
| g | The egress proxy connected to only the first address a name resolved to and had no connect timeout, so one unreachable address (dead node in a round-robin name, unroutable IPv6) could stall a request until the page gave up. Seen as an intermittent ~10 s render (the page-load timeout) on the first canary against a real production site; the demo site used by the suites had no such host | canary on the StageRage server | Addresses are tried in turn, IPv4 first, the next after 250 ms or at once on failure, with `EGRESS_CONNECT_TIMEOUT_MS`; unit tests including an end-to-end CONNECT with a dead first address (fails without the fix) |
| h | Every render of a page with a CAPTCHA widget (Turnstile) ended at the page-load timeout, and the first canary showed the old image caching renders in memory while this one did not (so every crawler hit cost a render) | canary on the StageRage server | The timeout is the page's own behaviour (the old image waited its full 20 s); the image has an optional render cache that keeps only clean 200 renders (`CACHE_TTL_S`); unit tests for the cache and the front server, and a real-browser suite that proves a clean page is served from the cache and a timed-out, failing or non-200 page is not |
| f | CodeQL: an over-broad regular expression character range in the CONNECT parser; test helper with certificate checking off and an unchecked dynamic call | code scanning on the PR | Simplified, removed, checked |

Test-harness mistakes that looked like product problems and were corrected: a benchmark that drew from the hostile mix (it reported 3 s outliers that were my own deliberately hanging page), a soak threshold on an unforced-GC heap, a text comparison that glued navigation links together, and a skipped test caused by an empty `skip` string.

## Measured results

4-core sandbox, Chromium 141 (Playwright's build; the Alpine image uses Alpine's), Node 22. Latency is wall clock from the caller.

**Latency and throughput** (`BENCH=1`, demo pages, p50 / p95 / p99 in ms):

| concurrency | simple page | SPA page | heavy page (3000 nodes) | pages/s |
| --- | --- | --- | --- | --- |
| 1 | 766 / 822 / 842 | 759 / 792 / 818 | 760 / 802 / 822 | 1.3 |
| 2 | 881 / 981 / 1006 | 891 / 974 / 1040 | 899 / 974 / 1298 | 2.2 |
| 4 | 1098 / 1247 / 1274 | 1141 / 1199 / 1249 | 1169 / 1296 / 1387 | 3.5 |

The tail is tight (p99 within about 10 % of p50 at concurrency 1). About 0.5 s of each page is the quiet period Prerender waits for after the last request.

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

The suites above use a demo site. This section is a canary on a real server with a real single-page app, run on 2026-10-24 and 2026-10-25.

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

**Resources:** after about 110 renders the container used 337 MiB of its 2 GiB (333 MiB after the first 60), 108 processes, and 2.3 to 2.6 % CPU when sampled right after a run.

**What this run found**

1. **Requests of an old page that never report back.** On the first canary about half of the renders ended at the 10 s page-load timeout, with the right content, where the
   community image took about 1.8 s. The page reloads itself, and the request left open at the timeout was, in 8 of 9 slow renders with the filter on, the error-reporting library's final
   beacon (the others: a script bundle, and with the filter off up to six API calls). Chromium never reported those requests as finished or failed, so Prerender waited for them. It was not
   the in-page request filter (about the same with it off), and not the proxy connecting (every tunnel opened in 5 to 7 ms, none failed, no request stayed paused). It was not reproduced with a
   local test page in 100+ renders. Fixed by `lib/orphans.js`: after the page starts a new document, requests of the old document get `NAVIGATION_SETTLE_MS` to report back and are then
   written off. Result: 0 of 20 slow, and the fix fired in 14 of those 20 renders.
2. **A page with a widget that never finishes.** The contact page (Cloudflare Turnstile) is not finished from Prerender's point of view, because the widget keeps connections open.
   It takes the full page-load timeout: 10.2 s with this image (10 s limit) and 20.2 s with the community image (its 20 s limit). The site-side fix is `window.prerenderReady`.
3. **One 504 on the home page in about 100 renders under load**, not reproduced in 38 more. The log showed a page-load timeout with one request still counted. Its cause is not known.

## Not covered

- The Docker image was not built or run in the sandbox where the suites were developed (no container runtime there). CI builds it, smoke-tests it, runs the attack and exhaustion suites against the container, and scans it; read the results of the run on the commit you deploy.
- Alpine's Chromium is not the Chromium used here; flags and behaviour were checked against the protocol, not against that build, except by CI.
- Linux only. No Windows or macOS host, no IPv6-only network, no Kubernetes run (the manifest is an example).
- No multi-hour soak and no tests with real third-party pages; the demo site is small by design.
- Real crawlers were not contacted. The bot test sends their user-agent strings through the same nginx rule real crawlers hit; it does not test how any crawler processes the answer.
- A browser zero-day is out of scope for any test. See the [threat model](threat-model.md).
