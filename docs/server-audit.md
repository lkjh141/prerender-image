# Server audit

`scripts/server-audit.sh` checks a real server without changing it. It is meant to be run by the operator on the machine that runs the image, and it prints what it finds.

## What it touches

- The production container (named `prerender` unless another name is given) is only inspected. The script reads its settings with `docker inspect`, its usage with
  `docker stats --no-stream`, its recent log with `docker logs --tail`, and its `/healthz` and `/metrics` with `curl`. It sends nothing else to it.
- Everything that is attacked or loaded runs in separate throw-away containers called `pt-audit`, `pt-site` and `pt-secret` on their own network `pt-net`. They use the same
  image as production, bound to `127.0.0.1` on a spare port (3902 by default), with 2 CPUs and 1 GB at most. They are removed when the script ends, including on Ctrl+C.
- nginx, redis, mongodb and every other container are never touched. The script stops at the start if a `pt-*` container already exists or the test port is in use.

## What it checks

1. Hardening of the production container: unprivileged user, read-only root filesystem, no privileges, all capabilities dropped, no host networking, memory and pids limits,
   ports published on `127.0.0.1` only, restart count, health, mounts, and the names (not the values) of the environment variables. It also scans the recent log for crash-type errors.
2. Attacks against the test container: a host that is not allowed, private and loopback addresses, an IPv4-mapped metadata address, the user-info trick, other schemes, broken
   escapes, control characters, a wrong method, a very long URL, error pages that could leak paths, and version headers.
3. A hostile page on an allowed site that tries to reach a "secret" service by `fetch`, an image, a WebSocket, the metadata address and several numeric and IPv6 spellings.
   The secret service logs every hit. The expected number is 0.
4. Timings on the real site: a cold render, a cached answer, 12 simultaneous callers for one new page, 300 cached answers in a row, cache size, and the test container's CPU and
   memory.
5. The public path (read-only requests to the site itself): a crawler must get a larger, rendered answer than a visitor, seven odd paths (double slash, `@`, encoded `..`, a NUL byte, an injected header, a query holding the metadata address) must never give a 5xx, sensitive content or an injected header, and the headers Cloudflare and nginx add are listed. Set `AUDIT_PUBLIC_URL` to use another address than `AUDIT_REAL_URL`.
6. A last look at production: it must still answer `/healthz` and must not have restarted.

## How to run it

```sh
cd /var/www/stagerage/repo   # or any checkout of this repository
bash scripts/server-audit.sh                 # production container "prerender", test port 3902
bash scripts/server-audit.sh prerender 3910  # another test port
```

The output has `PASS`, `FAIL` and `INFO` lines. A `FAIL` line names what to fix. Nothing is fixed automatically. The site checked can be changed with `AUDIT_SITE_HOSTS` and
`AUDIT_REAL_URL`.

## Results so far

The first two runs, on the production server, are in the [test report](test-report.md#audit-on-the-live-server). Both ended with no FAIL line. The script has one known limit: it
tests the image that the production container uses. To test a newer image before the swap, point the `IMAGE_ID=` line at its digest, for example:

```sh
NEW=ghcr.io/lkjh141/prerender-image@sha256:<digest>
docker pull $NEW && sed "s|^IMAGE_ID=.*|IMAGE_ID=$NEW|" scripts/server-audit.sh > /tmp/server-audit-new.sh && bash /tmp/server-audit-new.sh prerender 3902
```

The "image id" line in section 1 then shows the new digest, while the hardening checks still describe the `prerender` container.

## Checking a new image before the swap

`scripts/verify-image.sh IMAGE` is a shorter check of one image that does not need the production container at all. It starts a single throw-away container called `pt-verify` with the recommended hardening (read-only root, no capabilities, no new privileges, 512 processes, 2 GB, 2 CPUs), bound to `127.0.0.1:3903`, and removes it when it ends. If its private network does not exist yet, it creates one and removes it again. It stops without touching anything if a container of that name already exists or the port is in use.

It checks, one `PASS` or `FAIL` line each:

1. `/healthz`, a real render and the cached repeat.
2. Methods: `HEAD` answers 200 with the headers of a `GET` and no body; `POST`, `PUT`, `DELETE`, `PATCH`, `OPTIONS`, `TRACE` and `PROPFIND` get 405 with `Allow: GET, HEAD`, also with a 1 MB body.
3. 26 hostile targets, which must be refused and never answered with a 2xx or a 5xx: another host, loopback and private addresses, the cloud metadata address, IPv6 and numeric spellings, the user-info, suffix and prefix tricks, other schemes, traversal, a NUL byte, an injected header, a port that is not 80 or 443, a 20 kB URL and a 20 kB header.
4. No `X-Powered-By` or `Server` header, an HTML content type, and the metrics.
5. Speed and load: a cached answer under 0.5 s, 40 requests for one page with 20 at once, and 30 different uncached pages with 15 at once. None may fail with a 5xx or be dropped.
6. The container afterwards: still healthy, no restart, not killed for memory.

```sh
bash scripts/verify-image.sh ghcr.io/lkjh141/prerender-image@sha256:<digest>
VERIFY_HOST=stagerage.online VERIFY_PORT=3910 bash scripts/verify-image.sh <image>   # another allowed site or port
```

It exits with 1 when any check failed or the container did not become healthy, so it can also run in a pipeline on a machine with Docker. The load steps send about 70 real renders of the allowed host (`example.com` by default), so use a host that you own or that can take it.

## Long soak on the server

`scripts/server-soak.js` is a separate, longer check (default 60 minutes, `SOAK_MINUTES`). It runs entirely inside one throw-away container of the image, called `pt-soak`: nothing is published, nothing outside is
contacted, and the production container is not touched. Inside, it starts the service and a small synthetic site on loopback and repeats rounds of a burst of 16 callers for one new page, a mixed load of ordinary and hostile
pages (alert, pop-up, endless polling, never finishing) with many different URLs so the cache keeps evicting, and repeat requests for cached pages. Once a minute it records memory, descriptors, threads, processes, the cache
and the queue from `/proc`, and at the end it compares the second half of the run with the first. It exits with code 1 and a list of problems if something kept growing, an answer was wrong, a burst rendered more than once, or the
service did not recover. The container has the production limits (2 GB, 2 CPUs, 512 processes, read-only root, no capabilities).

```sh
docker run --rm --name pt-soak --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 512 --memory 2g --cpus 2 -v /tmp/server-soak.js:/soak/server-soak.js:ro -e SOAK_MINUTES=60 \
  --entrypoint node <image> /soak/server-soak.js
```

Run the audit first and the soak after it, not at the same time: both use 2 CPUs, and the server also runs production, redis and mongodb.

