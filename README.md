# prerender-image

A small, hardened container image for the open-source [Prerender](https://github.com/prerender/prerender) service: a headless
Chromium that renders JavaScript-built pages into plain HTML, so search and AI crawlers that do not run JavaScript can read a
single-page app.

The image is rebuilt from scratch every week on current Alpine, Node.js and Chromium, scanned for vulnerabilities, smoke-tested
and published to the GitHub Container Registry with a build attestation.

## What it adds to a plain Prerender setup

- **A host allowlist.** Prerender fetches whatever URL it is asked for. This image renders only the hosts in `ALLOWED_HOSTS` and
  answers everything else with 403, so it cannot be used to reach internal addresses (server-side request forgery) or as an open
  renderer. It will not start without the setting.
- **A filter for what the page loads.** While a page renders, requests to private, loopback and link-local addresses, to local-only
  names and to non-web schemes are refused inside the browser.
- **An unprivileged process** (the `node` user), `tini` as PID 1, SIGTERM handling, and a health check.
- **Patched dependencies.** The Prerender package itself dates from 2024; this build locks and audits its dependencies and fails
  on any known advisory.
- **A reproducible, pinned build:** base image by digest, locked npm dependencies, GitHub Actions pinned by commit.

The default plugins match the commonly used community image: pages can set their HTTP status code and headers with
`<meta name="prerender-status-code" content="404">` and `<meta name="prerender-header" content="Location: https://...">`, and
script tags are removed from the result.

## Quick start

```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ALLOWED_HOSTS=example.com,www.example.com \
  ghcr.io/lkjh141/prerender-image:latest

curl http://127.0.0.1:3000/https://example.com/some/page
```

The page to render is part of the path (`/https://example.com/some/page`), or use `/render?url=https://example.com/some/page`.
For real use, pin a digest instead of `latest` (see below) and start from [`compose.example.yaml`](compose.example.yaml), which runs
the image read-only, without capabilities and with limits.

Put your web server in front: send crawler requests to `http://127.0.0.1:3000/https://<your host><original path and query>`, and fall
back to your normal page if the service does not answer.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_HOSTS` | none, **required** | Host names that may be rendered, separated by commas. Exact names only: no wildcards, ports or schemes. A mistake stops the container, so it cannot silently allow too much. |
| `ALLOW_ANY_HOST` | `false` | `true` renders any host. Only safe when nothing else can be reached from the container's network. |
| `BLOCK_RESOURCES` | `false` | `true` also refuses trackers, ad networks, fonts and images while rendering. Faster; the text of the page does not depend on them. |
| `PORT` | `3000` | Port the service listens on. |
| `BROWSER_DEBUGGING_PORT` | `9222` | Chromium's debugging port (inside the container only). |
| `LOG_REQUESTS` | `false` | Log every request. |
| `PAGE_LOAD_TIMEOUT`, `WAIT_AFTER_LAST_REQUEST`, `PAGE_DONE_CHECK_INTERVAL`, `FOLLOW_REDIRECTS`, `CAPTURE_CONSOLE_LOG`, `ENABLE_SERVICE_WORKER`, `PARSE_SHADOW_DOM`, `TIMEOUT_STATUS_CODE`, `RENDERING_ERROR_STATUS_CODE`, `BROWSER_TRY_RESTART_PERIOD` | Prerender's defaults | Passed to Prerender unchanged. See its documentation. |

## Security notes

Read these before you expose the service to anything but your own web server.

1. **Keep it off the public internet.** Bind it to loopback (`127.0.0.1:3000:3000`) or a private network and let your web server call it.
2. **The allowlist covers the page you render, not everything it loads.** A rendered page may load scripts and call APIs on other
   hosts; those requests must work for the page to render. Private and local addresses are refused, but a public DNS name that points at
   a private address is resolved by the browser and is not caught by that filter. If the container can reach private networks, add an
   egress firewall or run it on a network that cannot.
3. **Chromium runs with `--no-sandbox`.** Containers usually do not allow the user namespaces Chromium's own sandbox needs. The
   container is the boundary instead: run it as shipped (unprivileged user), with `read_only`, `cap_drop: [ALL]`,
   `no-new-privileges` and memory and process limits, as in the compose example. A site you render is untrusted input to a browser.
4. **Render only sites you operate or trust.** Rendering arbitrary third-party sites with this service is a different risk and is
   not what it is designed for.

## Verifying and pinning the image

Every published image has a build attestation. To check that an image came from this repository's workflow:

```sh
gh attestation verify oci://ghcr.io/lkjh141/prerender-image@sha256:<digest> --repo lkjh141/prerender-image
```

Pin the digest in your deployment (the run summary of each build prints it) and update it deliberately, after reading what changed.
`latest` and the dated tags (`YYYYMMDD`) move; a digest does not.

## How patching works

- Every Monday the image is rebuilt without cache, so `apk upgrade` pulls the current Alpine, Chromium and Node packages.
- A build fails when the scan finds a HIGH or CRITICAL vulnerability that has a fix. Vulnerabilities without a fix yet are printed
  in the scan output of each run but cannot block the build.
- Dependabot proposes updates to the base image digest, the npm packages and the actions.

## Development

```sh
npm ci
npm test                              # unit tests; the browser test is skipped without Chromium
CHROME_BIN=/path/to/chromium npm test # also runs the browser test against a local page
scripts/smoke.sh <image>              # the same checks CI runs against a built image
```

## Licence

MIT, see [LICENSE](LICENSE). Bundled software keeps its own licences, see [NOTICE](NOTICE). Not affiliated with Prerender Inc.
