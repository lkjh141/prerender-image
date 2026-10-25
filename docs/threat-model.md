# Threat model

What this service is, who could attack it, what is done about each way in, and what is left. Findings marked **reproduced** were demonstrated by a test
against the first version of this image or against stock Prerender before they were fixed; the [test report](test-report.md) lists the tests.

The service takes a URL, opens it in a real browser, and returns the HTML. That one sentence explains most of the risk. The browser runs code that someone else wrote, on a machine the operator
owns, usually inside a network that trusts it. The controls below exist to keep that code from reaching anything it was not meant to reach.

## What is being protected

- The network the container sits on: cloud metadata services, databases, other containers, admin interfaces.
- The host and the other containers (container escape from a compromised browser).
- Availability of the service, and of the machine it runs on.
- The integrity of what crawlers receive: they must not be given content, headers or status codes an attacker chose.

## Who can attack

| Attacker | Capability |
| --- | --- |
| **Anyone who can send a request to the service** | Chooses the URL. Should be only the operator's web server, but a mistake in the network or proxy configuration can expose it. |
| **A crawler or visitor, through the operator's web server** | Chooses the path that the web server forwards. |
| **The content of a page being rendered** | Everything the page's JavaScript and servers can do: a compromised third-party script, a stored cross-site-scripting injection, a hostile ad or widget, a user-generated page. Every rendered page should be treated as hostile code running in a browser inside the operator's network. |
| **Another host on the network path** | Can answer for a page's server if certificates are not checked. |

## The ways in, and what stops them

The controls are layered on purpose. The front server checks the request before any browser time is spent. The egress proxy checks every connection the browser makes, below the page, where
JavaScript cannot get around it. The container limits what a compromised browser could do even if both of those failed.

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
| 26 | A page reaches a private address through an unusual IPv6 spelling or an embedded IPv4 address (expanded IPv4-mapped, NAT64, 6to4, site-local, Teredo, documentation ranges) | Internal service or metadata reached | Addresses are parsed to their eight 16-bit groups and judged by the embedded IPv4 address where one is carried; reserved, documentation and transition ranges are refused too; checked against a differential fuzz of 200,000 random addresses | `ipclassify`, `guard`, `egress` |
| 27 | A site in `ALLOWED_HOSTS` is pointed at the server's own public address to reach another service there (ssh, a database) on a port the egress proxy would refuse | Local service reached through the public address | A listed host that resolves to a public address keeps to `EGRESS_ALLOWED_PORTS`; only a private (development) address may use other ports, and never the service's own | `egress` |
| 28 | Many callers ask for the same uncached page at once (a crawler burst, a cold start, or an attacker repeating one URL) | Every slot busy with identical renders; other pages wait or get 503 | With the cache on, the first caller renders and the others wait for it, up to 256 per page; waiters that leave are dropped; if the render cannot be kept they render on their own | `adversarial/cache` |

### Notes on some of the rows

**Rows 2 to 6 and 26: why the check sits in a proxy.** A filter inside the page only sees what the page asks for. A frame from another site runs in its own browser process, and WebSocket and WebRTC traffic does not go through the
page's request hooks, so each of those slipped past a page-level filter in the tests marked **reproduced**. The browser is therefore forced to send every connection through a local proxy. The proxy resolves the name itself, refuses
the connection if any returned address is private, and connects to the exact address it checked. The browser never resolves the name a second time, so a DNS answer that changes between the check and the connection has nothing to exploit.
Row 26 exists because an address can be written in many forms. The classifier does not match text patterns. It parses the address and, where the address carries an IPv4 address inside it, judges that one.

**Row 8: the DevTools port.** Whoever reaches the browser's debugging port controls the browser. The port listens on loopback only, and the proxy refuses the service's own ports even when `127.0.0.1` is on the allowlist,
so a page on an allowed host still cannot talk to the service itself.

**Row 11: certificates.** Stock Prerender accepts every certificate. That means a host on the network path could answer for the real server and its content would be rendered and handed to crawlers as if it were genuine.
This image turns checking back on for each tab.

**Row 14: error text.** Prerender's web framework answers a malformed percent-escape with a page that shows a stack trace and file paths. The front server validates the path first and answers with a short fixed text, so internal details never leave the container.

**Rows 16 to 19: limits instead of trust.** Pages are not trusted to finish, so each request has a deadline, the number of pages rendered at once is capped, and extra requests wait in a bounded queue or are turned away with 503.
A request that takes too long gets 504. These answers are deliberate. They keep the process alive, and a refused caller can try again.

**Row 22: the container is the boundary.** The browser runs with `--no-sandbox`, which is usual in containers, so the isolation has to come from the container itself. That is why the image runs as the unprivileged `node` user,
and why the compose and Kubernetes examples set a read-only filesystem, drop all capabilities, forbid privilege escalation and cap memory and process count.

**Row 25: the cache.** The cache holds only what the front server has already validated. A cached answer is the same answer a fresh render would have produced, so the cache adds a place to store pages but no new way to choose their content. It is off unless `CACHE_TTL_S` is set.

**Row 27: why a listed host is still limited.** A listed host is trusted to be the site itself, so a development page on a private address may use any port. A name that resolves to a public address is different. If an
attacker could point that name at the server's own public address, the page could try ssh or a database port on the same machine. Keeping such hosts to `EGRESS_ALLOWED_PORTS` (80 and 443 by default) closes that path.

## What is left (residual risk)

These are real. They are listed so that nobody believes the image is more than it is.

1. **A browser exploit.** Chromium is a large codebase that parses hostile input. The Alpine package is updated by the weekly rebuild, but a zero-day in the window
   between a fix and a rebuild is possible. Mitigation is containment: unprivileged, read-only, no capabilities, resource limits, and a network that cannot reach anything private.
   The container-level controls should not be removed because the egress proxy exists; each one covers a failure of the others.
2. **The browser runs without its own sandbox** (`--no-sandbox`), as is usual in containers. The container is the sandbox. If the environment can allow user namespaces and a seccomp profile for Chromium, the browser's sandbox
   is a second layer worth enabling; this image does not assume it.
3. **A page can reach public hosts.** That is required for rendering (scripts, APIs, fonts). A page being rendered can make requests to the public internet from the server's address.
   It cannot read the responses of an internal service, but it can, for example, trigger a request to a public URL with a side effect. The operator should render only sites the operator runs.
4. **`ALLOWED_HOSTS` entries are trusted.** A listed host may be private, and a hostile page on a listed host is in scope of everything above. Hosts the operator does not control should not be listed.
5. **Content, not code, is the output.** The answer is HTML from the operator's site after its scripts ran. If a script on that site is compromised, the crawler receives what it produced. The service removes script tags and sends a restrictive CSP, but it does not sanitize the text.
6. **No authentication.** Anything that can reach the port can ask for a render of an allowed host. The allowlist limits the damage to rendering the operator's own site, but an attacker could still use up render capacity. The defence is the network, and a cache.
7. **Denial of service is bounded, not impossible.** The limits turn exhaustion into 503/504 answers and keep the process alive, but a determined caller can still fill the queue and make other callers wait or fail. Rate limiting belongs in the operator's web server.
8. **Not tested here:** the Docker image itself was exercised by CI's smoke test, not by the author locally (no container runtime in the sandbox where the suites were developed); Windows or macOS hosts; Kubernetes (the manifest in the guide is an example); other Chromium versions than the one in the Alpine release; IPv6-only networks; very large sites (thousands of subresources per page).
