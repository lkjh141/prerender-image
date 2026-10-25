# Implementation guide

This guide takes a site owner from "a single-page app that crawlers cannot read" to a running, checked setup. Every step says how to
verify it. The nginx configuration was run against this image and the behaviours listed under "Check it" were observed; the
Kubernetes example is a standard manifest that this project's CI does not run.

The problem is simple. A single-page app sends an almost empty HTML file and builds the page with JavaScript. Many crawlers do not run that JavaScript, so they index an empty shell.
This service runs the JavaScript once, on the server, and hands the crawler the finished page.

## 1. How the pieces fit

```
crawler ──► the web server ──► prerender-image (headless Chromium) ──► the site (fetched like any visitor)
                │  other visitors
                └──────────────► the single-page app, as usual
```

1. The site's web server looks at the User-Agent. A crawler's request for a **page** is handed to the prerender service.
2. The service opens that page in headless Chromium, waits until it has finished loading, and returns the final HTML.
3. Everything else (normal visitors, scripts, images, API calls) never touches the service.

The contract is small, so any web server or CDN can do step 1: request `http://<service>:3000/<the full public URL of the page>`
and send the response back with its status code and headers. Only the page address is sent, so cookies and other headers do not reach the service.
That is deliberate: the render is the same for every caller, which is also what makes it safe to cache.

## 2. Run the service

The starting point is [`compose.example.yaml`](../compose.example.yaml). The settings that matter:

| Setting | Why |
|---|---|
| `ALLOWED_HOSTS` | **Required.** The host names of the site's own domains. Anything else is refused with 403. Without this list, the service would render any URL a caller sent, including internal ones. |
| `ports: "127.0.0.1:3000:3000"` | Reachable from this machine only. The web server runs next to it. |
| `read_only`, `tmpfs: /tmp`, `cap_drop: [ALL]`, `no-new-privileges` | The container is the security boundary because Chromium runs without its own sandbox. |
| `mem_limit: 1g`, `pids_limit` | One render uses a few hundred MB; a runaway page must not take the host down. A rule of thumb, not a measurement: watch `docker stats` under the site's own traffic and adjust. |
| `CACHE_TTL_S` | Optional. Seconds a finished render is kept in memory and served again without a browser (default `0`, off). A few milliseconds per hit instead of about 2 s for a real single-page app. Only clean `200` renders are kept; see [configuration](configuration.md#render-cache-optional-off-by-default). |
| image pinned by `@sha256:...` | The operator decides when the image changes. See "Operate" below. |

Check that it started and is healthy:

```sh
docker compose up -d
docker compose ps                      # STATUS shows "healthy" after about 20 seconds
curl -i http://127.0.0.1:3000/healthz  # 200 once the browser is up
curl -s http://127.0.0.1:3000/https://example.com/ | head   # the site's own page, rendered (use the real host)
curl -i http://127.0.0.1:3000/https://other.example/        # 403: not in ALLOWED_HOSTS
```

The `/healthz` answer is worth knowing. It is `200` only while the browser is connected and the service is not shutting down. Otherwise it is `503`.
The container's own health check calls the same address, which is why `docker compose ps` can show "starting" or "unhealthy" while the browser is still coming up or has died.

## 3. Route crawlers to it (nginx)

The configuration to use is [`nginx.example.conf`](nginx.example.conf). It does four things:

- recognises crawlers by User-Agent (`$is_crawler`);
- never sends the service's own browser back to itself (`$is_prerender_browser`), which would cause a render loop;
- sends only **page** requests: a path that ends in a file extension is served as the file (`$send_to_prerender`);
- falls back to the normal app shell if the service is down (`error_page ... = @without_prerender`), so the site never goes down because of it.

After reloading nginx (`nginx -t && nginx -s reload`), check it.

### Check it

`example.com` stands for the site's own name. Each line says what should come back.

```sh
# A normal visitor still gets the plain app shell:
curl -s https://example.com/about | grep -c 'id="root"></div>'        # 1  (the shell's empty root element)

# A crawler gets the rendered page:
curl -s -A 'Mozilla/5.0 (compatible; Googlebot/2.1)' https://example.com/about | head -c 400
curl -s -A 'GPTBot/1.2' https://example.com/ | head -c 400

# Query strings survive:
curl -s -A Googlebot 'https://example.com/search?q=a%20b' | head -c 400

# Files are not rendered:
curl -s -A Googlebot https://example.com/assets/app.js | head -c 100   # the JavaScript itself

# Status codes come through (see section 4; the not-found view must set the meta tag):
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
The same four rules apply: crawlers only, pages only, never the service's own browser, and a fallback when it is down. Each can be tested with the
`curl` lines above. This project only provides and tests the nginx configuration.

## 4. Make the app render-friendly

The service renders what a browser would show once the page has settled. Three things help.

**Tell it the real status code.** A single-page app answers `200` for every route, so a missing page looks fine to a crawler, and a search engine may index it as a real page.
The page should carry this tag when it is a "not found" view:

```html
<meta name="prerender-status-code" content="404">
```

The service returns HTTP 404 and removes the tag from the result. A redirect works the same way:

```html
<meta name="prerender-status-code" content="301">
<meta name="prerender-header" content="Location: https://example.com/new-address">
```

Only a short list of headers is passed on (content type, `Location`, cache headers, `Link` and a few more), and a `Location` value must start with `http://`, `https://` or `/`. A page cannot use these tags to set cookies or
security headers, because the service drops them. That keeps a compromised script from poisoning what crawlers or a cache receive.

**Tell it when the page is ready.** By default the service waits until the network is quiet. If the data arrives later (a slow API,
a timer), a flag makes the service wait:

```js
window.prerenderReady = false;           // as early as possible, before the app starts
// ... when the page content is complete:
window.prerenderReady = true;
```

**Keep structured data.** `<script type="application/ld+json">` blocks are kept in the result; all other script tags are removed, because
a crawler does not need them and running them again could change the page.

Content that appears only after a user action (a click, a scroll) should be avoided. The crawler will not see it either.

## 5. Operate it

**Pin and update on purpose.** The digest should be used, not `latest`. The weekly build produces a new image with current security fixes. The operator updates
when ready: read the run summary, change the digest in the compose file, then `docker compose pull && docker compose up -d`. To
roll back, put the old digest back.

**Verify what is pulled.** Every published image has a build attestation:

```sh
gh attestation verify oci://ghcr.io/lkjh141/prerender-image@sha256:<digest> --repo lkjh141/prerender-image
```

The check proves the image was built by this repository's workflow from the stated source. A digest that fails it should not be run.

**Watch it.** `docker compose ps` shows the health state; `docker compose logs prerender` shows refused requests
(`refused a request for a host that is not allowed`) and requests blocked inside the page (`blocked a request made by the page`). Both are
useful: the first shows probing, the second shows a page that tries to reach a private address.

**Caching and deploys.** With `CACHE_TTL_S` set, a crawler can see the page as it was before the latest release until the entry expires. The container should be restarted as the last step of a deploy
(`docker restart prerender`); a restart empties the cache, and the first request after it is rendered again. There is deliberately no flush endpoint, because the service has no authentication.
To check that the cache works, run `curl -sI http://127.0.0.1:3000/https://example.com/ | grep -i x-prerender-cache`: the header reads `miss` the first time and `hit` the second.

**Replacing a community image on a running server.** This is the procedure that was used on the StageRage server, and it can be undone in seconds.

1. Run the new image next to the old one on a second port with the real settings, and compare. Use the same `ALLOWED_HOSTS` as production, give it `--memory 2g`, and render a few of the site's own pages:
   `curl -s http://127.0.0.1:3003/https://example.com/news` against the old container's port. The pages should be the same size and have the same title, canonical and robots tags.
2. Stop and rename the old container, then start the new one under the old name and port, so nothing else has to change:
   ```sh
   docker stop prerender && docker rename prerender prerender-old
   docker run -d --name prerender --restart unless-stopped -p 127.0.0.1:3002:3000 \
     --log-opt max-size=10m --log-opt max-file=3 \
     --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges:true \
     --pids-limit 512 --memory 2g \
     -e ALLOWED_HOSTS=example.com,www.example.com -e CACHE_TTL_S=3600 \
     ghcr.io/lkjh141/prerender-image@sha256:<digest>
   ```
   While the port is down, a web server set up as in section 3 falls back to the normal app, so visitors see no error.
3. Run a check through the web server, as a crawler (for StageRage, `scripts/check-prerender.sh`).
4. Roll back at any time with `docker rm -f prerender && docker rename prerender-old prerender && docker start prerender`. The old container (`docker rm prerender-old`) should be removed only after the new one has run cleanly for a day.

**Do not expose it.** The service has no authentication. It listens on loopback in the examples for that reason. Anyone who can reach the port can use up render capacity, and the web server is the right place to rate-limit.

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

A `NetworkPolicy` should be added that allows ingress only from the web server and egress only to the internet and DNS, never to the cluster's
private ranges. The image's egress proxy already refuses private addresses, including names that resolve to them; the policy is a second layer, so that one control failing does not expose the cluster. Before version 2 a public DNS name that pointed at a private address was
resolved by the browser.

## 7. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The container exits at once | `ALLOWED_HOSTS` is missing or contains something that is not a plain host name (a port, a scheme, a wildcard). The log line says which. |
| `403` for a page of the site's own | The host is not in `ALLOWED_HOSTS`, or the wrong host was passed (for example `www.` when only the bare name is listed). The log shows the refused address. |
| The page comes back with an empty root element | The page was not finished when the service took its snapshot. Use `window.prerenderReady`, or raise `WAIT_AFTER_LAST_REQUEST_MS` / `PAGE_LOAD_TIMEOUT_MS`. |
| One page always takes the whole `PAGE_LOAD_TIMEOUT_MS`, the others about 2 s | The page has something that never finishes loading (a CAPTCHA widget, a chat widget that holds a connection open, a long-polling request). The answer is still complete, only late. Set `window.prerenderReady = false` early and `true` once the content is there; the service then answers at once. Such a page is never kept by the cache, because it did not finish cleanly. |
| Renders end at the page-load timeout, `page timed out ... requestsInFlight=1` in the log | A request is still counted as running. If the page reloads itself, the request of the old page may never be reported by the browser; the service writes those off after `NAVIGATION_SETTLE_MS` (`wrote off ... request(s) of the previous document` in the log). If the page does not reload itself, look in the log for which request never finishes. |
| `504` | The render failed or timed out. Check that the service can reach the site, and that the page finishes loading. |
| `503` with a `Retry-After` header | The service is busy or shutting down. All render slots (`MAX_CONCURRENCY`) and the wait queue (`MAX_QUEUE`) are full, a request waited longer than `QUEUE_TIMEOUT_MS`, the heap is nearly full, or the container is draining for a stop. The answer is short on purpose. Retry later, and rate-limit at the web server if it keeps happening. |
| A part of the page is missing | The page loads it from a private address or a non-web scheme, which is blocked. That host goes in `ALLOWED_HOSTS` only if it is meant to be reached. |
| Square boxes instead of text | A language needs a font the image does not contain. Open an issue, or add the package to the Dockerfile. |
| Chromium crashes or the container restarts | It ran out of memory. Raise `mem_limit`, and check for pages that load very large resources. |
| `EROFS` / permission errors with `read_only: true` | `/tmp` must be a writable `tmpfs`, as in the example. |
| Every render triggers another | The service's own User-Agent is being sent back to it. The `$is_prerender_browser` rule must stay. |
| Crawlers get the empty shell for `/` only | `try_files $uri/` or an `index` directive serves the directory before the crawler check. The `rewrite` form from the example avoids this. |

## 8. FAQ

**Why a separate image and not an existing one?** Community images are rarely rebuilt. A widely used one was last published in October 2025,
and scanning it today lists dozens of known vulnerabilities in its operating-system packages and bundled Node packages. This image is rebuilt from
scratch every week.

**Does it cache?** Optionally. Setting `CACHE_TTL_S` (seconds) keeps a clean `200` render in memory (up to `CACHE_MAX_MB`, 64 by default, and `CACHE_MAX_ENTRIES`) and serves it again without a browser, in a few milliseconds. It is off by default. Renders that timed out or had a failing request are never kept. Caching can also be done in the web server or CDN (for example nginx `proxy_cache`); the two work together.

**Can it render other people's sites?** It is not designed for that. The allowlist exists so the service renders only what the operator runs. `ALLOW_ANY_HOST=true`
turns it off, and then the service must sit on a network where nothing sensitive is reachable. The [threat model](threat-model.md) lists why: a rendered page is hostile code running in a browser inside that network.

**Which platforms?** `linux/amd64` for now.

**Is it a replacement for server-side rendering?** No. It is a bridge for sites that already are single-page apps. If the app can render on the
server, that is simpler and faster.
