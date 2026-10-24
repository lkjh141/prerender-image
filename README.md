# prerender-image

[![Build](https://github.com/lkjh141/prerender-image/actions/workflows/build.yml/badge.svg)](https://github.com/lkjh141/prerender-image/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A hardened, weekly-rebuilt container image for the open-source [Prerender](https://github.com/prerender/prerender) service.**
It runs headless Chromium to turn JavaScript-built pages into plain HTML, so search engines and AI crawlers that do not run
JavaScript can read your single-page app. It is meant for sites you operate, behind your own web server.

```
crawler ──► your web server ──► prerender-image ──► your site
 visitor ──► your web server ──► your single-page app, as usual
```

**Contents:** [Why this image](#why-this-image) · [Quick start](#quick-start) · [Implementation guide](docs/implementation-guide.md) ·
[Settings](#settings) · [Security notes](#security-notes) · [Verify and pin](#verifying-and-pinning-the-image) ·
[How patching works](#how-patching-works) · [Development](#development)

## Why this image

Prerender fetches whatever URL it is asked for, and its community images are rarely rebuilt. This image keeps the behaviour people rely on and
fixes those two problems.

| | Typical community image | This image |
|---|---|---|
| Which hosts can be rendered | any | only `ALLOWED_HOSTS`; everything else gets 403, and the container will not start without the setting |
| What the rendered page may reach | anything | private, loopback and link-local addresses, local names and non-web schemes are refused inside the browser |
| Process user | often root | unprivileged `node` user, `tini` as PID 1, SIGTERM handled, health check |
| Package managers in the image | npm, npx, yarn, corepack | none; removed from the runtime image, which shrinks the attack surface |
| Runs read-only with no capabilities | rarely tested | tested in CI on every build |
| Operating-system packages | as of the last build | rebuilt from scratch every Monday, fixable HIGH/CRITICAL findings fail the build |
| npm dependencies | as published | locked and audited; any advisory fails the build |
| Provenance | none | build attestation and SBOM on every published image |

The default plugins match what most setups use: a page can set its HTTP status and headers with
`<meta name="prerender-status-code" content="404">` and `<meta name="prerender-header" content="Location: https://...">`, and script tags are
removed from the result (JSON-LD structured data is kept).

## Quick start

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ALLOWED_HOSTS=example.com,www.example.com \
  ghcr.io/lkjh141/prerender-image:latest

curl http://127.0.0.1:3000/https://example.com/some/page
```

The page to render is part of the path (`/https://example.com/some/page`), or use `/render?url=https://example.com/some/page`.
An empty request, or a host that is not in `ALLOWED_HOSTS`, is answered with 403.

For real use, pin a digest instead of `latest` and start from [`compose.example.yaml`](compose.example.yaml), which runs the image read-only,
without capabilities, with limits and bound to loopback.

**Next:** the [implementation guide](docs/implementation-guide.md) walks through the whole setup, step by step, with a tested nginx
configuration ([`docs/nginx.example.conf`](docs/nginx.example.conf)), how to make your app report real status codes and signal when it is ready,
how to check it works, a Kubernetes example, troubleshooting and an FAQ.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_HOSTS` | none, **required** | Host names that may be rendered, separated by commas. Exact names only: no wildcards, ports or schemes. A mistake stops the container, so it cannot silently allow too much. |
| `ALLOW_ANY_HOST` | `false` | `true` renders any host. Only safe when nothing sensitive can be reached from the container's network. |
| `BLOCK_RESOURCES` | `false` | `true` also refuses trackers, ad networks, fonts and images while rendering. Faster; the text of the page does not depend on them. |
| `PORT` | `3000` | Port the service listens on. |
| `BROWSER_DEBUGGING_PORT` | `9222` | Chromium's debugging port (inside the container only). |
| `LOG_REQUESTS` | `false` | Log every request. |
| `PAGE_LOAD_TIMEOUT`, `WAIT_AFTER_LAST_REQUEST`, `PAGE_DONE_CHECK_INTERVAL`, `FOLLOW_REDIRECTS`, `CAPTURE_CONSOLE_LOG`, `ENABLE_SERVICE_WORKER`, `PARSE_SHADOW_DOM`, `TIMEOUT_STATUS_CODE`, `RENDERING_ERROR_STATUS_CODE`, `BROWSER_TRY_RESTART_PERIOD` | Prerender's defaults | Passed to Prerender unchanged. See its documentation. |

## Security notes

Read these before you expose the service to anything but your own web server.

1. **Keep it off the public internet.** It has no authentication. Bind it to loopback (`127.0.0.1:3000:3000`) or a private network and let your
   web server call it.
2. **The allowlist covers the page you render, not everything it loads.** A rendered page may load scripts and call APIs on other hosts; those
   requests must work for the page to render. Private and local addresses are refused, but a public DNS name that points at a private address is
   resolved by the browser and is not caught by that filter. If the container can reach private networks, add an egress firewall or run it on a
   network that cannot.
3. **Chromium runs with `--no-sandbox`.** Containers usually do not allow the user namespaces Chromium's own sandbox needs. The container is the
   boundary instead: run it as shipped (unprivileged user), with `read_only`, `cap_drop: [ALL]`, `no-new-privileges` and memory and process
   limits, as in the compose example. A site you render is untrusted input to a browser.
4. **Render only sites you operate or trust.** Rendering arbitrary third-party sites with this service is a different risk and is not what it is
   designed for.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Verifying and pinning the image

Every published image has a build attestation. To check that an image came from this repository's workflow:

```sh
gh attestation verify oci://ghcr.io/lkjh141/prerender-image@sha256:<digest> --repo lkjh141/prerender-image
```

Pin the digest in your deployment (the run summary of each build prints it) and update it deliberately, after reading what changed.
`latest` and the dated tags (`YYYYMMDD`) move; a digest does not.

## How patching works

- Every Monday the image is rebuilt without cache, so `apk upgrade` pulls the current Alpine, Chromium and Node packages.
- A build fails when the scan finds a HIGH or CRITICAL vulnerability that has a fix. Vulnerabilities without a fix yet are printed in the scan
  output of each run but cannot block the build.
- Dependabot proposes updates to the base image digest, the npm packages and the actions.
- Every build runs the unit tests, then starts the built image the way the compose example does (read-only, no capabilities) and checks that it
  renders a script-built page, honours the status meta tag, refuses other hosts, runs unprivileged and reports healthy.

## Development

```sh
npm ci
npm test                              # unit tests; the browser test is skipped without Chromium
CHROME_BIN=/path/to/chromium npm test # also runs the browser test against a local page
scripts/smoke.sh <image>              # the same checks CI runs against a built image
```

| Path | What it is |
|---|---|
| `server.js` | Starts Prerender with the container's Chromium flags and the guard plugin |
| `lib/guard.js` | The host allowlist and the filter for what the page loads |
| `test/` | Unit tests and a browser test that renders a local page and proves the guard works |
| `Dockerfile`, `scripts/smoke.sh` | The image and the checks run against it |
| `docs/` | The implementation guide and the tested nginx configuration |

## Licence

MIT, see [LICENSE](LICENSE). Bundled software keeps its own licences, see [NOTICE](NOTICE). Not affiliated with Prerender Inc.
