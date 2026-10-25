# prerender-image

[![Build](https://github.com/lkjh141/prerender-image/actions/workflows/build.yml/badge.svg)](https://github.com/lkjh141/prerender-image/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A hardened, weekly-rebuilt container image for the open-source [Prerender](https://github.com/prerender/prerender) service.**
It runs headless Chromium to turn JavaScript-built pages into plain HTML, so search engines and AI crawlers that do not run
JavaScript can read a single-page app. A single-page app sends the browser an almost empty shell and builds the content in the browser. A crawler that
does not run JavaScript sees only the shell. This image loads the page in a real browser, waits until it settles, and hands back the finished HTML.
It is meant for sites the operator runs, behind the operator's own web server.

```
crawler ──► the site's web server ──► prerender-image ──► the site
 visitor ──► the site's web server ──► the single-page app, as usual
```

The web server decides who is a crawler (usually by user agent) and sends only those requests to the image. Visitors never touch it.

**Contents:** [Why this image](#why-this-image) · [Quick start](#quick-start) · [Implementation guide](docs/implementation-guide.md) ·
[Measured results](#measured-results) · [Settings](#settings) · [Security notes](#security-notes) · [Verify and pin](#verifying-and-pinning-the-image) ·
[How patching works](#how-patching-works) · [Development](#development)

**Deep documentation:** [Architecture](docs/architecture.md) · [Threat model](docs/threat-model.md) · [Test report](docs/test-report.md) ·
[Configuration and sizing](docs/configuration.md) · [Verification and auto-merge](docs/automerge-and-verification.md)

## Why this image

Prerender fetches whatever URL it is asked for. Its community images are rarely rebuilt. The service itself has gaps that only show under attack or
load. This image keeps the behaviour people rely on and closes those gaps. Each row below was **reproduced by a test first** and is covered by a test
now; the [test report](docs/test-report.md) has the evidence.

| | Stock Prerender / typical community image | This image |
|---|---|---|
| Which hosts can be rendered | any | only `ALLOWED_HOSTS`; everything else gets 403, and the container will not start without the setting |
| What the rendered page may reach | anything the container can reach | an egress proxy that Chromium cannot bypass resolves names itself, refuses private, loopback and link-local addresses, and pins the connection to the address it checked. This covers sub-frames in other processes, WebSocket, WebRTC and DNS names that resolve to private addresses, which a page-level filter does not |
| TLS certificates | **any certificate is accepted** (expired, self-signed, wrong host) | validated; `ALLOW_INVALID_CERTS=true` opts out for development |
| Error pages | stack traces and file paths (`/…/%zz`, odd `POST /render` bodies) | a short fixed text; Prerender is not reachable from outside |
| `/render` API (POST, injected JavaScript, PDF, screenshots) | open | closed: only `GET /<url>` |
| Load | unlimited concurrency and queue; each page's state is held for up to 60 s, so memory grows with the request rate and the process runs out of memory (about 100 pages at a 384 MB heap) | bounded concurrency and queue, deadline, response size cap, early release of per-request memory, 503 instead of a crash. 300 mixed renders leave the heap flat |
| A page that calls `alert()` in a loop | **can end the whole process** (an unhandled promise rejection) | handled and counted |
| A hung, crashed or frozen browser | a frozen browser is never noticed | liveness probe, stale-tab sweeper, memory recycling, automatic restart; tested with `SIGKILL` and `SIGSTOP` |
| Response headers from the rendered site | all passed on, including `Set-Cookie` | a short allowlist; no cookies, no security headers; 204/205/304 never passed on |
| Shutdown | immediate | drains running pages, exits 0, leaves no browser behind |
| Process user | often root | unprivileged `node` user, `tini` as PID 1, health check on `/healthz` |
| Package managers in the image | npm, npx, yarn, corepack | none |
| Runs read-only with no capabilities | rarely tested | tested in CI on every build |
| Operating-system packages | as of the last build | rebuilt from scratch every Monday, fixable HIGH/CRITICAL findings fail the build |
| npm dependencies | as published | locked and audited; any advisory fails the build |
| Provenance | none | build attestation and SBOM on every published image; the published digest is pulled and smoke-tested again |

The default plugins match what most setups use. A page can set its HTTP status and headers with
`<meta name="prerender-status-code" content="404">` and `<meta name="prerender-header" content="Location: https://...">`. Script tags are
removed from the result, and JSON-LD structured data is kept. Headers set this way still pass through the header allowlist described above.

## Quick start

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ALLOWED_HOSTS=example.com,www.example.com \
  ghcr.io/lkjh141/prerender-image:latest

curl http://127.0.0.1:3000/https://example.com/some/page
```

The page to render is part of the path (`/https://example.com/some/page`). A host that is not in `ALLOWED_HOSTS` is answered with 403. Anything
that is not `GET /<http or https URL>` is answered with 404, 405 or 400. `GET /healthz` is the health check.

The published port is bound to `127.0.0.1` in the example because the service has no authentication. Only a process on the same machine,
normally the web server, should be able to reach it.

For real use, pin a digest instead of `latest` and start from [`compose.example.yaml`](compose.example.yaml). That file runs the image read-only,
without capabilities, with limits, and bound to loopback.

**Next:** the [implementation guide](docs/implementation-guide.md) walks through the whole setup, step by step. It includes a tested nginx
configuration ([`docs/nginx.example.conf`](docs/nginx.example.conf)), how to make the app report real status codes and signal when it is ready,
how to check that it works, a Kubernetes example, troubleshooting and an FAQ.

## Measured results

These figures were measured in a 4-core sandbox with Chromium 141, rendering a small client-side-rendered demo site (router, API data, lazy comments, JSON-LD, soft-404).
The demo site is small on purpose, so treat the numbers as a guide to relative cost and not as a promise for another site.
They can be reproduced with `test/bots/run.js`, `test/bots/tuning.js` and `BENCH=1 node --test test/adversarial/soak.test.js`. Numbers from the Alpine image in CI may differ somewhat.

**What crawlers and AI bots receive** (11 user agents: Googlebot, Bingbot, GPTBot, ChatGPT-User, OAI-SearchBot, ClaudeBot, PerplexityBot, Applebot, facebookexternalhit, Twitterbot, LinkedInBot; 7 pages each)

| | without the service | with the service |
|---|---|---|
| Words a person sees that the bot also gets | 0 % (an empty "Loading…" shell) | **100 %** |
| Pages with the right `<title>`, description, canonical, `og:title`, `<h1>` | 0 % | **100 %** |
| Product page structured data (JSON-LD) valid | 0 % | **100 %** |
| Internal links the bot can follow from the home page | 0 | 5 of 5 |
| Missing pages answered with a real 404 | 0 % (soft 200) | **100 %** |
| Application scripts left in the page | 1 per page | 0 |

**What it costs**

| | |
|---|---|
| Time to render a page | about 0.75 s for a simple page, 0.85 s median and 1.3 s at the 95th percentile for the demo site (most of it the 500 ms quiet period Prerender waits for) |
| Served from a cache | 0 to 1 ms |
| CPU | about 0.33 CPU-seconds per rendered page |
| Memory | browser peaked at about 420 MB with up to 4 pages at once, the service itself about 200 MB; flat over 300 mixed renders |
| Throughput | about 3.5 pages a second at 4 pages at once on 4 cores; 1.3 a second one at a time |
| Overload | queue of 32, then immediate 503; nginx falls back to the normal app |
| Long run | 300 mixed renders (10 % hostile pages): 0 failures, heap flat, file descriptors and processes flat, one browser |

**On a real production site** (a React single-page app behind Cloudflare, rendered on a 4 vCPU, 8 GB server in a 2 GB container; details in the [test report](docs/test-report.md#measured-on-a-real-production-site))

| | |
|---|---|
| One page after another (home page, 20 renders) | 1.75 to 2.35 s, mean 2.0 s, none reached the 10 s page-load timeout |
| Against the community image it replaces (10 pairs) | 2.12 s mean against 1.83 s: about 0.3 s slower on an uncached page |
| Five page types, 4 renders at once (40 renders) | slowest 3.7 s; 39 of 40 answered 200, 1 answered 504 |
| Home page, 24 renders, 4 at once | 0 timeouts, slowest 5.7 s |
| With the render cache (`CACHE_TTL_S=3600`) | first render 2.0 to 2.8 s, every repeat 1.4 to 3.4 ms with the same bytes; the second round over a 30-page sitemap was 29 hits in under 6 ms; 32 pages used 3.6 MB |
| Swapped in for the community image on the live server | the site's own crawler check (`check-prerender.sh`, through nginx as Googlebot) passed; home and news pages were byte for byte the same as the old image's |
| Memory after about 110 renders | 337 MiB of the 2 GiB limit |

**What it protects against** (each reproduced first, see the [test report](docs/test-report.md)): bad certificates being accepted, four ways
around a page-level SSRF filter, stack traces in error pages, an `alert()` loop ending the process, memory growth that ran the stock service out of memory after
about 100 pages, a frozen browser going unnoticed, cookies and security headers copied from the rendered site, script tags left on 404 pages.

**Tuning, and the one thing the app can do to help.** Prerender decides that a page is finished when the page has made no network request for
`WAIT_AFTER_LAST_REQUEST_MS`. Content that appears after 500 ms or more with no network activity (for example a component that starts late) is therefore not waited for.
If the app sets `window.prerenderReady = false` early and `true` when the page is done, Prerender waits for that signal instead, and every setting renders the page completely (12 of 12 in the test), at any speed.
`WAIT_AFTER_LAST_REQUEST_MS=200` is then safe and makes a simple page take about 0.45 s.

**Checking a live server.** [docs/server-audit.md](docs/server-audit.md) describes `scripts/server-audit.sh`, a read-only audit that inspects the production container and attacks and load-tests only separate throw-away containers.

## Settings

These are the settings an operator is most likely to change. The full reference, with every limit, its range and sizing advice, is in [docs/configuration.md](docs/configuration.md).

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_HOSTS` | none, **required** | Host names that may be rendered, separated by commas. Exact names only: no wildcards, ports or schemes. A mistake stops the container, so it cannot silently allow too much. |
| `ALLOW_ANY_HOST` | `false` | `true` renders any **public** host. Private and local addresses stay refused. |
| `MAX_CONCURRENCY` | `4` | Pages rendered at once. Plan about 1.2 GB for the default. |
| `MAX_QUEUE` | `32` | Requests that may wait for a free slot. More get 503 straight away. |
| `REQUEST_TIMEOUT_MS` | `30000` | Hard limit for one request, then 504. |
| `WAIT_AFTER_LAST_REQUEST_MS` | `500` | Quiet time after the page's last request before it counts as finished. `200` makes a simple page take about 0.45 s instead of 0.75 s. |
| `CACHE_TTL_S` | `0` | Seconds a finished render is kept in memory and served again without a browser. `0` is off. Only clean `200` renders are kept; see [configuration](docs/configuration.md#render-cache-optional-off-by-default). `CACHE_MAX_MB` (64) and `CACHE_MAX_ENTRIES` (2000) bound it. |
| `NAVIGATION_SETTLE_MS` | `750` | When a page navigates itself (a script reload or redirect), the time given to requests of the old document to report back before they are written off. Range 100 to 10000. |
| `EGRESS_ALLOWED_PORTS` | `80,443` | Ports a page may reach. A listed host on a private address (a development page) may use any port except the service's own; a listed host on a public address keeps to these. |
| `PAGE_FILTER` | `true` | `false` switches off the in-page request filter. The egress proxy still enforces every network rule, so the SSRF protection stays. |
| `DIAGNOSTICS` | `false` | `true` adds log lines for each browser connection through the egress proxy (address, connect time, who closed it, bytes) and for requests that never finished. |
| `BLOCK_RESOURCES` | `false` | `true` also refuses trackers, ad networks, fonts and images while rendering. |
| `ALLOW_INVALID_CERTS` | `false` | `true` accepts bad certificates. Development only. |
| `METRICS_ENABLED` | `false` | `true` serves Prometheus text on `/metrics`. |
| `PORT` | `3000` | Port the service listens on. |

Version 2 renamed `PAGE_LOAD_TIMEOUT`, `WAIT_AFTER_LAST_REQUEST` and `PAGE_DONE_CHECK_INTERVAL` to `PAGE_LOAD_TIMEOUT_MS`,
`WAIT_AFTER_LAST_REQUEST_MS` and `PAGE_DONE_CHECK_INTERVAL_MS`. The old names are ignored, so a deployment that still sets them runs with the defaults.
A value that is not valid stops the container with a plain message (see [configuration](docs/configuration.md)).

## Security notes

These notes are for anyone who will expose the service to anything but the operator's own web server. The [threat model](docs/threat-model.md) has the full list.

1. **Keep it off the public internet.** It has no authentication. The operator should bind it to loopback (`127.0.0.1:3000:3000`) or a private network and let the
   web server call it.
2. **The allowlist covers the page being rendered; the egress proxy covers what that page loads.** A rendered page may call APIs on other public hosts, because
   it needs to. It cannot reach private, loopback or link-local addresses, however it asks (frame, WebSocket, WebRTC, a name that resolves to a private address).
   The proxy is the enforcement point inside the container. The operator should **still** run the container on a network that cannot reach anything private, because
   a second layer is cheap and the browser is the largest piece of code in the image.
3. **Chromium runs with `--no-sandbox`.** Containers usually do not allow the user namespaces that Chromium's own sandbox needs. The container is the
   boundary instead. It should run as shipped (unprivileged user), with `read_only`, `cap_drop: [ALL]`, `no-new-privileges` and memory and process
   limits, as in the compose example. A site that is rendered is untrusted input to a browser.
4. **Render only sites the operator runs or trusts.** Rendering arbitrary third-party sites with this service is a different risk and is not what it is
   designed for.
5. **Use a cache.** Rendering is the expensive part, and a cache is also the best protection against a crawler (or an attacker) asking for
   the same page over and over. `CACHE_TTL_S` turns on the built-in cache (a repeat answer takes a few milliseconds and needs no browser). A cache in front works too, as the nginx example in the guide shows.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Verifying and pinning the image

Every published image has a build attestation, a signed record of which workflow built it. This command checks that an image came from this repository's workflow:

```sh
gh attestation verify oci://ghcr.io/lkjh141/prerender-image@sha256:<digest> --repo lkjh141/prerender-image
```

The operator should pin the digest in the deployment (the run summary of each build prints it) and update it deliberately, after reading what changed.
`latest` and the dated tags (`YYYYMMDD`) move. A digest does not, so a pinned deployment only changes when the operator changes it.

## How patching works

- Every Monday the image is rebuilt without cache, so `apk upgrade` pulls the current Alpine, Chromium and Node packages.
- A build fails when the scan finds a HIGH or CRITICAL vulnerability that has a fix. Vulnerabilities without a fix yet are printed in the scan
  output of each run but cannot block the build, because nothing can be done about them until a fix exists.
- Dependabot proposes updates to the base image digest, the npm packages and the actions.
- Every build runs the unit tests and the attack, exhaustion and load suites against a real browser. It then starts the built image the way the compose
  example does (read-only, no capabilities) and checks that it renders a script-built page, honours the status meta tag, refuses other hosts, answers bad input
  without internals, runs unprivileged, reports healthy and stops cleanly on SIGTERM. After publishing, the pushed digest is pulled and checked again, so
  the check covers the exact bytes that users will pull.
- Pull requests are merged automatically only when they are verified and approved; Dependabot patch and minor updates are merged once verified, major
  updates wait for a person. See [docs/automerge-and-verification.md](docs/automerge-and-verification.md).

## Development

```sh
npm ci
npm test                              # unit tests; the browser suites are skipped without Chromium
CHROME_BIN=/path/to/chromium npm test # also runs the attack, exhaustion, resilience and soak suites (about 10 minutes)
BENCH=1 CHROME_BIN=/path/to/chromium node --test test/adversarial/soak.test.js   # latency and throughput table
scripts/smoke.sh <image>              # the same checks CI runs against a built image
```

| Path | What it is |
|---|---|
| `server.js` | Wires the parts together, signals, process-level error policy |
| `lib/front.js`, `lib/egress.js`, `lib/guard.js`, `lib/watchdog.js`, `lib/release.js`, `lib/settings.js` | The public server, the egress proxy, the allowlist and Prerender plugin, the watchdog, early memory release, the settings. See [docs/architecture.md](docs/architecture.md) |
| `test/*.test.js` | Unit tests for each part (no browser) |
| `test/adversarial/` | Attack (SSRF, response, input), exhaustion, resilience and soak suites against a real browser; `test/lab/lab.js` is the harness |
| `Dockerfile`, `scripts/smoke.sh` | The image and the checks run against it |
| `scripts/automerge*.js`, `.github/workflows/` | The auto-merge rules and the pipeline |
| `docs/` | Architecture, threat model, test report, configuration, implementation guide, tested nginx configuration |

## Licence

MIT, see [LICENSE](LICENSE). Bundled software keeps its own licences, see [NOTICE](NOTICE). Not affiliated with Prerender Inc.
