# Implementation guide

This guide takes you from "I have a single-page app that crawlers cannot read" to a running, checked setup. Every step says how to
verify it. The nginx configuration was run against this image and the behaviours listed under "Check it" were observed; the
Kubernetes example is a standard manifest that this project's CI does not run.

## 1. How the pieces fit

```
crawler ──► your web server ──► prerender-image (headless Chromium) ──► your site (fetched like any visitor)
                │  other visitors
                └──────────────► your single-page app, as usual
```

1. Your web server looks at the User-Agent. A crawler's request for a **page** is handed to the prerender service.
2. The service opens that page in headless Chromium, waits until it has finished loading, and returns the final HTML.
3. Everything else (normal visitors, scripts, images, API calls) never touches the service.

The contract is small, so any web server or CDN can do step 1: request `http://<service>:3000/<the full public URL of the page>`
and send the response back with its status code and headers. Only the page address is sent, so cookies and other headers do not reach the service.

## 2. Run the service

Start from [`compose.example.yaml`](../compose.example.yaml). The settings that matter:

| Setting | Why |
|---|---|
| `ALLOWED_HOSTS` | **Required.** The host names of your own site. Anything else is refused with 403. |
| `ports: "127.0.0.1:3000:3000"` | Reachable from this machine only. Your web server runs next to it. |
| `read_only`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges` | The container is the security boundary because Chromium runs without its own sandbox. |
| `mem_limit: 1g`, `pids_limit` | One render uses a few hundred MB; a runaway page must not take the host down. A rule of thumb, not a measurement: watch `docker stats` under your own traffic and adjust. |
| image pinned by `@sha256:...` | You decide when the image changes. See "Operate" below. |

Check that it started and is healthy:

```sh
docker compose up -d
docker compose ps                      # STATUS shows "healthy" after about 20 seconds
curl -i http://127.0.0.1:3000/healthz  # 200 once the browser is up
curl -s http://127.0.0.1:3000/https://example.com/ | head   # your own page, rendered (use your host)
curl -i http://127.0.0.1:3000/https://other.example/        # 403: not in ALLOWED_HOSTS
```

## 3. Route crawlers to it (nginx)

Use [`nginx.example.conf`](nginx.example.conf). It does four things:

- recognises crawlers by User-Agent (`$is_crawler`);
- never sends the service's own browser back to itself (`$is_prerender_browser`), which would cause a render loop;
- sends only **page** requests: a path that ends in a file extension is served as the file (`$send_to_prerender`);
- falls back to the normal app shell if the service is down (`error_page ... = @without_prerender`), so the site never goes down because of it.

Reload nginx (`nginx -t && nginx -s reload`), then check it.

### Check it

Replace `example.com` with your site. Each line says what you should see.

```sh
# A normal visitor still gets the plain app shell:
curl -s https://example.com/about | grep -c 'id="root"></div>'        # 1  (your shell's empty root element)

# A crawler gets the rendered page:
curl -s -A 'Mozilla/5.0 (compatible; Googlebot/2.1)' https://example.com/about | head -c 400
curl -s -A 'GPTBot/1.2' https://example.com/ | head -c 400

# Query strings survive:
curl -s -A Googlebot 'https://example.com/search?q=a%20b' | head -c 400

# Files are not rendered:
curl -s -A Googlebot https://example.com/assets/app.js | head -c 100   # the JavaScript itself

# Status codes come through (see section 4; your not-found view must set the meta tag):
curl -s -o /dev/null -w '%{http_code}\n' -A Googlebot https://example.com/no-such-page   # 404
curl -s -o /dev/null -w '%{http_code}\n' https://example.com/no-such-page                # 200: a normal visitor gets the app, which draws its own not-found view

# Stop the service, and crawlers still get an answer:
docker compose stop prerender
curl -s -o /dev/null -w '%{http_code}\n' -A Googlebot https://example.com/about          # 200, the plain shell
```

These were run against a real nginx and this service, with these results: a normal visitor received the plain shell; Googlebot and GPTBot
received the script-built page without any `<script>` tag; a request for a `.js` file was served raw; the service's own User-Agent received
the shell; the query string survived; with the service stopped, Googlebot received HTTP 200 and the shell. Through the same nginx, a
not-found view with the meta tag returned HTTP 404 with the tag removed, a redirect view returned `301` with its `Location` header, and a page
that set `window.prerenderReady = false` was returned only after it set it to `true`.

### Other web servers and CDNs

Any server that can (a) match a User-Agent, (b) rewrite the path to `/<full URL>` and (c) proxy the response can do the same.
Keep the same four rules: crawlers only, pages only, never the service's own browser, and a fallback when it is down. Test them with the
`curl` lines above. This project only provides and tests the nginx configuration.

## 4. Make your app render-friendly

The service renders what a browser would show once the page has settled. Three things help.

**Tell it the real status code.** A single-page app answers `200` for every route, so a missing page looks fine to a crawler.
Add this to the page when it is a "not found" view:

```html
<meta name="prerender-status-code" content="404">
```

The service returns HTTP 404 and removes the tag from the result. A redirect works the same way:

```html
<meta name="prerender-status-code" content="301">
<meta name="prerender-header" content="Location: https://example.com/new-address">
```

**Tell it when the page is ready.** By default the service waits until the network is quiet. If your data arrives later (a slow API,
a timer), set a flag so it waits for you:

```js
window.prerenderReady = false;           // as early as possible, before your app starts
// ... when the page content is complete:
window.prerenderReady = true;
```

**Keep structured data.** `<script type="application/ld+json">` blocks are kept in the result; all other script tags are removed, because
a crawler does not need them and running them again could change the page.

Also avoid content that appears only after a user action (a click, a scroll). The crawler will not see it either.

## 5. Operate it

**Pin and update on purpose.** Use the digest, not `latest`. The weekly build produces a new image with current security fixes. Update
when you choose to: read the run summary, change the digest in your compose file, then `docker compose pull && docker compose up -d`. To
roll back, put the old digest back.

**Verify what you pull.** Every published image has a build attestation:

```sh
gh attestation verify oci://ghcr.io/lkjh141/prerender-image@sha256:<digest> --repo lkjh141/prerender-image
```

**Watch it.** `docker compose ps` shows the health state; `docker compose logs prerender` shows refused requests
(`refused a request for a host that is not allowed`) and requests blocked inside the page (`blocked a request made by the page`). Both are
useful: the first shows probing, the second shows a page that tries to reach a private address.

**Do not expose it.** The service has no authentication. It listens on loopback in the examples for that reason.

## 6. Kubernetes

A minimal deployment with the same protections. This is a standard manifest and is **not** run by this project's CI.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: prerender
spec:
  replicas: 1
  selector:
    matchLabels: { app: prerender }
  template:
    metadata:
      labels: { app: prerender }
    spec:
      terminationGracePeriodSeconds: 30   # longer than DRAIN_TIMEOUT_MS, so running pages can finish
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - name: prerender
          image: ghcr.io/lkjh141/prerender-image@sha256:REPLACE_WITH_THE_DIGEST_YOU_REVIEWED
          env:
            - { name: ALLOWED_HOSTS, value: "example.com,www.example.com" }
          ports:
            - containerPort: 3000
          readinessProbe:
            httpGet: { path: /healthz, port: 3000 }   # 200 only while the browser is connected and the pod is not shutting down
          resources:
            requests: { memory: 1Gi, cpu: 500m }
            limits: { memory: 2Gi }
          securityContext:
            readOnlyRootFilesystem: true
            allowPrivilegeEscalation: false
            capabilities: { drop: [ALL] }
          volumeMounts:
            - { name: tmp, mountPath: /tmp }
      volumes:
        - name: tmp
          emptyDir: { medium: Memory, sizeLimit: 512Mi }
---
apiVersion: v1
kind: Service
metadata:
  name: prerender
spec:
  selector: { app: prerender }
  ports:
    - port: 3000
```

Add a `NetworkPolicy` that allows ingress only from your web server and egress only to the internet and DNS, never to your cluster's
private ranges. The image's egress proxy already refuses private addresses, including names that resolve to them; the policy is a second layer. Before version 2 a public DNS name that pointed at a private address was
resolved by the browser.

## 7. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| The container exits at once | `ALLOWED_HOSTS` is missing or contains something that is not a plain host name (a port, a scheme, a wildcard). The log line says which. |
| `403` for a page of your own site | The host is not in `ALLOWED_HOSTS`, or you passed the wrong host (for example `www.` when only the bare name is listed). The log shows the refused address. |
| The page comes back with an empty root element | The page was not finished when the service took its snapshot. Use `window.prerenderReady`, or raise `WAIT_AFTER_LAST_REQUEST_MS` / `PAGE_LOAD_TIMEOUT_MS`. |
| `504` | The render failed or timed out. Check that the service can reach your site, and that the page finishes loading. |
| A part of the page is missing | The page loads it from a private address or a non-web scheme, which is blocked. Put that host in `ALLOWED_HOSTS` only if it is meant to be reached. |
| Square boxes instead of text | A language needs a font the image does not contain. Open an issue, or add the package to the Dockerfile. |
| Chromium crashes or the container restarts | It ran out of memory. Raise `mem_limit`, and check for pages that load very large resources. |
| `EROFS` / permission errors with `read_only: true` | `/tmp` must be a writable `tmpfs`, as in the example. |
| Every render triggers another | The service's own User-Agent is being sent back to it. Keep the `$is_prerender_browser` rule. |
| Crawlers get the empty shell for `/` only | `try_files $uri/` or an `index` directive serves the directory before the crawler check. Use the `rewrite` form from the example. |

## 8. FAQ

**Why a separate image and not an existing one?** Community images are rarely rebuilt. A widely used one was last published in October 2025,
and scanning it today lists dozens of known vulnerabilities in its operating-system packages and bundled Node packages. This image is rebuilt from
scratch every week.

**Does it cache?** No. Cache in your web server or CDN (for example nginx `proxy_cache` on `/__prerender`) if your traffic needs it.

**Can I render other people's sites?** It is not designed for that. The allowlist exists so the service renders only what you run. `ALLOW_ANY_HOST=true`
turns it off, and then the service must sit on a network where nothing sensitive is reachable.

**Which platforms?** `linux/amd64` for now.

**Is it a replacement for server-side rendering?** No. It is a bridge for sites that already are single-page apps. If you can render on the
server, that is simpler and faster.
