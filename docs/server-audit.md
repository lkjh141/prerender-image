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
5. A last look at production: it must still answer `/healthz` and must not have restarted.

## How to run it

```sh
cd /var/www/stagerage/repo   # or any checkout of this repository
bash scripts/server-audit.sh                 # production container "prerender", test port 3902
bash scripts/server-audit.sh prerender 3910  # another test port
```

The output has `PASS`, `FAIL` and `INFO` lines. A `FAIL` line names what to fix. Nothing is fixed automatically. The site checked can be changed with `AUDIT_SITE_HOSTS` and
`AUDIT_REAL_URL`.
