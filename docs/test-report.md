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

## Not covered

- The Docker image was not built or run in the sandbox where the suites were developed (no container runtime there). CI builds it, smoke-tests it, runs the attack and exhaustion suites against the container, and scans it; read the results of the run on the commit you deploy.
- Alpine's Chromium is not the Chromium used here; flags and behaviour were checked against the protocol, not against that build, except by CI.
- Linux only. No Windows or macOS host, no IPv6-only network, no Kubernetes run (the manifest is an example).
- No multi-hour soak and no tests with real third-party pages; the demo site is small by design.
- Real crawlers were not contacted. The bot test sends their user-agent strings through the same nginx rule real crawlers hit; it does not test how any crawler processes the answer.
- A browser zero-day is out of scope for any test. See the [threat model](threat-model.md).
