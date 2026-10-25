# Threat model

What this service is, who could attack it, what is done about each way in, and what is left. Findings marked **reproduced** were demonstrated by a test
against the first version of this image or against stock Prerender before they were fixed; the [test report](test-report.md) lists the tests.

## What is being protected

- The network the container sits on: cloud metadata services, databases, other containers, admin interfaces.
- The host and the other containers (container escape from a compromised browser).
- Availability of the service, and of the machine it runs on.
- The integrity of what crawlers receive: they must not be given content, headers or status codes an attacker chose.

## Who can attack

| Attacker | Capability |
| --- | --- |
| **Anyone who can send a request to the service** | Chooses the URL. Should be only your web server, but a mistake in your network or proxy configuration can expose it. |
| **A crawler or visitor, through your web server** | Chooses the path that your web server forwards. |
| **The content of a page you render** | Everything the page's JavaScript and servers can do: a compromised third-party script, a stored cross-site-scripting injection, a hostile ad or widget, a user-generated page. Treat every rendered page as hostile code running in a browser inside your network. |
| **Another host on the network path** | Can answer for a page's server if certificates are not checked. |

## The ways in, and what stops them

| # | Attack | Result without protection | Protection | Test |
| --- | --- | --- | --- | --- |
| 1 | Ask for an internal URL (`http://169.254.169.254/…`, `http://localhost:…`, `file:///etc/passwd`) | Server-side request forgery (SSRF): internal data returned to the caller | `ALLOWED_HOSTS` allowlist in the front server and again in Prerender; only http/https; no user-info (`allowed@evil`) | `ssrf`, `guard`, `front` |
| 2 | A rendered page calls an internal address (fetch, image, form, redirect) | Internal data sent to the page, or acted on | Egress proxy; plus the per-tab request filter | `ssrf` |
| 3 | A page loads a **frame from another site** (runs in its own browser process) | Bypasses a page-level filter. **Reproduced.** | Egress proxy | `ssrf` |
| 4 | A page opens a **WebSocket** to an internal address | Bypasses a page-level filter. **Reproduced.** | Egress proxy (`CONNECT`) | `ssrf` |
| 5 | A page uses **WebRTC** to send UDP to an internal address | Bypasses a page-level filter. **Reproduced.** | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` plus the proxy | `ssrf` |
| 6 | A public name that **resolves to a private address** (including DNS rebinding sets that return one public and one private address) | Bypasses a filter that looks at names. **Reproduced.** | The proxy resolves, refuses if any answer is private, and connects to the address it checked | `ssrf`, `egress` |
| 7 | Numeric spellings (`2130706433`, `0x7f.1`, `[::ffff:127.0.0.1]`, `017700000001`) | Look public, are not | URL parsing, then address classification after resolution | `ssrf`, `egress`, `guard` |
| 8 | A page reaches the **DevTools port** | Full control of the browser, including reading other pages | The service's own ports are refused by the proxy even when `127.0.0.1` is allowed; the port is loopback only | `ssrf`, `egress` |
| 9 | A page reads local files | Secrets in the container | `file:` refused at every layer | `ssrf` |
| 10 | Pop-ups, extra tabs | Escapes tracking and limits | `--block-new-web-contents`; the watchdog closes any tab that outlives its request | `exhaustion` |
| 11 | Pages behind **bad certificates** | Content from an impostor server rendered and handed to crawlers. **Reproduced**: stock Prerender accepts every certificate. | Certificate checking switched back on per tab | `response` |
| 12 | A page sets **cookies, CSP, HSTS, CORS headers** or a nonsense status on the answer through `prerender-header` / `prerender-status-code` | Cache or crawler poisoning, header injection | Header allowlist; status filter; the service's own security headers | `response`, `front` |
| 13 | Line breaks in header values | Response splitting | Node refuses them; allowlist | `response` |
| 14 | Malformed percent-escapes, control characters, very long paths, unusual methods, smuggling attempts, slow clients | Stack trace and file paths in the answer (**reproduced**), crashes, resource use | Validation in the front server with fixed texts; HTTP server limits | `input`, `front` |
| 15 | `POST /render` with JavaScript to run, PDF/screenshot rendering | Arbitrary script in the page, heavy rendering | Not exposed | `input`, smoke test |
| 16 | **Flood of requests** | Out of memory or CPU, other tenants starved | Concurrency, queue, timeouts, load shedding, connection cap | `exhaustion` |
| 17 | A page that **never finishes**, loops forever, allocates without bound, trickles bytes, opens thousands of requests or frames | Slots held forever, memory exhausted | Deadlines; the watchdog; per-page heap cap; response size cap; egress connection limits | `exhaustion` |
| 18 | A page that calls **`alert()` in a loop** | **Reproduced**: ends the whole Node process | Dialogs dismissed at once; unhandled rejections counted instead of fatal | `exhaustion` |
| 19 | **Steady load** | **Reproduced**: memory grows with request rate (about 4.5 MB per page for a minute) until the process runs out of memory | Early release of request state; heap-pressure shedding | `soak` |
| 20 | The **browser dies or freezes** | Silent outage | Restart on death; liveness probe kills a frozen browser; exit if none comes back | `resilience` |
| 21 | **Stop signal while busy** | Dropped requests, orphaned browser | Drain, exit 0, process-group signal | `resilience`, smoke test |
| 22 | A compromised browser | Code execution as the `node` user | Non-root, read-only filesystem, no capabilities, no-new-privileges, no package manager in the image, memory/pid limits. `--no-sandbox` means the container **is** the sandbox | smoke test |
| 23 | A vulnerable base image or dependency | Known exploit | Weekly rebuild from scratch, Trivy (fixable HIGH/CRITICAL fails), `npm audit`, locked dependencies, pinned action SHAs | CI |
| 24 | A tampered image | Malicious image deployed | Provenance attestation, SBOM, pin by digest, verify | CI |
| 25 | The optional render cache is filled with junk (many query strings), or holds a wrong or incomplete page | Useful pages pushed out; crawlers served stale or partial content | Bounded by bytes and entries with least-recently-used eviction; only a clean `200` render is kept (never a timeout, a failed request of the page, an error, another status, `no-store`/`private`); the key is the validated URL and the answer never depends on the caller; off unless `CACHE_TTL_S` is set; no flush endpoint | `cache`, `front`, `adversarial/cache` |

## What is left (residual risk)

These are real. They are listed so that nobody believes the image is more than it is.

1. **A browser exploit.** Chromium is a large codebase that parses hostile input. The Alpine package is updated by the weekly rebuild, but a zero-day in the window
   between a fix and a rebuild is possible. Mitigation is containment: unprivileged, read-only, no capabilities, resource limits, and a network that cannot reach anything private.
   Do not remove the container-level controls because the egress proxy exists.
2. **The browser runs without its own sandbox** (`--no-sandbox`), as is usual in containers. The container is the sandbox. If you can allow user namespaces and a seccomp profile for Chromium in your environment, the browser's sandbox
   is a second layer worth enabling; this image does not assume it.
3. **A page can reach public hosts.** That is required for rendering (scripts, APIs, fonts). A page you render can make requests to the public internet from your server's address.
   It cannot read the responses of an internal service, but it can, for example, trigger a request to a public URL with a side effect. Render only sites you operate.
4. **`ALLOWED_HOSTS` entries are trusted.** A listed host may be private, and a hostile page on a listed host is in scope of everything above. Do not list hosts you do not control.
5. **Content, not code, is the output.** The answer is HTML from your site after its scripts ran. If a script on your site is compromised, the crawler receives what it produced. The service removes script tags and sends a restrictive CSP, but it does not sanitize the text.
6. **No authentication.** Anything that can reach the port can ask for a render of an allowed host. The allowlist limits the damage to rendering your own site, but an attacker could still use up render capacity. Use the network, and a cache.
7. **Denial of service is bounded, not impossible.** The limits turn exhaustion into 503/504 answers and keep the process alive, but a determined caller can still fill the queue and make other callers wait or fail. Rate-limit at your web server.
8. **Not tested here:** the Docker image itself was exercised by CI's smoke test, not by me locally (no container runtime in the sandbox where the suites were developed); Windows or macOS hosts; Kubernetes (the manifest in the guide is an example); other Chromium versions than the one in the Alpine release; IPv6-only networks; very large sites (thousands of subresources per page).
