'use strict';

const dns = require('node:dns');
const http = require('node:http');
const net = require('node:net');
const { isPrivateAddress, normalizeHost } = require('./guard');

// A forward proxy that Chromium is forced to use for every connection (--proxy-server). This is where "do not reach private
// networks" is enforced, because it sits below the page: it covers sub-frames in other processes, WebSocket, fetch, images,
// and everything else the browser opens, and it cannot be bypassed from JavaScript.
//
//   - The proxy resolves the name itself, refuses the connection when ANY returned address is private, and then connects to
//     that exact address. The browser never gets to resolve the name a second time, so DNS rebinding has nothing to race.
//   - Hosts listed in ALLOWED_HOSTS are the operator's own choice and may be private (for example a development page).
//   - The service's own ports (front, Prerender, DevTools, this proxy) are never reachable from a page, even on an allowed host.
//   - Unless the host is in ALLOWED_HOSTS, only EGRESS_ALLOWED_PORTS (80 and 443 by default) can be reached.
//   - Connections are counted, idle-limited and lifetime-limited, so a page cannot hold the container's sockets open.

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);


/**
 * Connects to the first of several addresses that answers. Attempts start in turn (IPv4 first, then IPv6), the next one after
 * `staggerMs` or as soon as the previous one fails, so one unreachable address (a black-holed IPv6 route, a dead node behind a
 * round-robin name) costs a fraction of a second instead of the whole connect timeout. The browser does the same when it connects
 * itself; this proxy has to do it for the browser. Resolves with the connected socket, rejects when every attempt failed or
 * `timeoutMs` passed.
 */
function connectAny(addresses, port, { staggerMs = 250, timeoutMs = 8000, connect = net.connect } = {}) {
  const ordered = [...addresses.filter(a => net.isIP(a) === 4), ...addresses.filter(a => net.isIP(a) !== 4)];
  return new Promise((resolve, reject) => {
    const attempts = [];
    let settled = false;
    let failed = 0;
    let nextIndex = 0;
    let stagger = null;
    const finish = (error, socket, winner) => {
      if (settled) return;
      settled = true;
      clearTimeout(stagger);
      clearTimeout(overall);
      for (const attempt of attempts) if (attempt !== winner) attempt.destroy();
      if (error) reject(error); else resolve(socket);
    };
    const overall = setTimeout(() => finish(Object.assign(new Error('connect timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    const start = () => {
      if (settled || nextIndex >= ordered.length) return;
      const socket = connect({ host: ordered[nextIndex], port });
      nextIndex += 1;
      attempts.push(socket);
      socket.once('connect', () => finish(null, socket, socket));
      socket.once('error', error => {
        failed += 1;
        socket.destroy();
        if (failed >= ordered.length) finish(error);
        else { clearTimeout(stagger); start(); } // the next address at once
      });
      if (nextIndex < ordered.length) stagger = setTimeout(start, staggerMs);
    };
    if (ordered.length === 0) { finish(new Error('no address')); return; }
    start();
  });
}

function createDnsCache(lookup, ttlMs, maxEntries = 1000) {
  const cache = new Map();
  return async function resolve(host) {
    const now = Date.now();
    const hit = cache.get(host);
    if (hit && hit.until > now) return hit.addresses;
    const addresses = (await lookup(host, { all: true, verbatim: true })).map(entry => entry.address);
    if (ttlMs > 0) {
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(host, { addresses, until: now + ttlMs });
    }
    return addresses;
  };
}

/**
 * @param {object} options
 * @param {object} options.config guard settings (allowedHosts, allowPrivate)
 * @param {object} options.settings tuning settings
 * @param {Set<number>} options.reservedPorts ports of this service, never reachable from a page
 * @param {Function} [options.log]
 * @param {Function} [options.lookup] dns.promises.lookup, replaceable in tests
 */
function createEgressProxy({ config, settings, reservedPorts, log = () => {}, lookup = dns.promises.lookup, connect = net.connect }) {
  const resolveName = createDnsCache(lookup, settings.EGRESS_DNS_TTL_MS);
  const stats = { allowed: 0, blocked: 0, blockedByReason: {}, openTunnels: 0, timeouts: 0, errors: 0 };
  const sockets = new Set();

  function block(reason, target) {
    stats.blocked += 1;
    stats.blockedByReason[reason] = (stats.blockedByReason[reason] || 0) + 1;
    log(`egress blocked (${reason}): ${JSON.stringify(String(target).slice(0, 120))}`);
    return { ok: false, reason };
  }

  /** Decide whether host:port may be reached and, when it may, which address to connect to. */
  async function decide(rawHost, port) {
    const host = normalizeHost(rawHost);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return block('bad-target', `${rawHost}:${port}`);
    const listed = config.allowedHosts.includes(host);
    if (!listed && !settings.EGRESS_ALLOWED_PORTS.includes(port)) return block('port', `${host}:${port}`);

    let addresses;
    if (net.isIP(host)) {
      addresses = [host];
    } else {
      try { addresses = await resolveName(host); } catch { return block('dns', host); }
    }
    if (addresses.length === 0) return block('dns', host);

    const publicOnly = !listed && !config.allowPrivate;
    if (publicOnly && addresses.some(isPrivateAddress)) return block('private-address', `${host} -> ${addresses.join(',')}`);
    // A page must never be able to talk to the service itself, even when its host is on the allowlist.
    if (reservedPorts.has(port) && addresses.some(isPrivateAddress)) return block('service-port', `${host}:${port}`);
    return { ok: true, address: addresses[0], addresses };
  }

  function track(socket) {
    // A keep-alive connection carries many requests; register it once, or every request adds another listener.
    if (sockets.has(socket)) return;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  }

  function limit(socket, other) {
    socket.setTimeout(settings.EGRESS_IDLE_TIMEOUT_MS, () => { stats.timeouts += 1; socket.destroy(); if (other) other.destroy(); });
    const lifetime = setTimeout(() => { stats.timeouts += 1; socket.destroy(); if (other) other.destroy(); }, settings.EGRESS_MAX_LIFETIME_MS);
    lifetime.unref();
    socket.once('close', () => clearTimeout(lifetime));
  }

  const server = http.createServer({ maxHeaderSize: 16384 });
  server.maxConnections = settings.EGRESS_MAX_TUNNELS + 16;

  // HTTPS and WebSocket: a CONNECT tunnel. The bytes are not read or changed; the browser still verifies the certificate.
  server.on('connect', async (req, clientSocket, head) => {
    track(clientSocket);
    clientSocket.on('error', () => {});
    const match = /^(\[[\w:.%]+\]|[^:\s[\]]+):(\d{1,5})$/.exec(String(req.url));
    if (!match) { clientSocket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
    if (stats.openTunnels >= settings.EGRESS_MAX_TUNNELS) {
      block('too-many-connections', req.url);
      clientSocket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    stats.openTunnels += 1;
    let released = false;
    const release = () => { if (!released) { released = true; stats.openTunnels -= 1; } };
    clientSocket.once('close', release);

    const verdict = await decide(match[1], Number(match[2]));
    if (!verdict.ok) { clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
    if (clientSocket.destroyed) return;

    stats.allowed += 1;
    let upstream;
    try {
      upstream = await connectAny(verdict.addresses, Number(match[2]), { timeoutMs: settings.EGRESS_CONNECT_TIMEOUT_MS, connect });
    } catch {
      stats.errors += 1;
      if (!clientSocket.destroyed) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    if (clientSocket.destroyed) { upstream.destroy(); return; }
    track(upstream);
    upstream.setNoDelay(true);
    upstream.on('error', () => { stats.errors += 1; if (!clientSocket.destroyed) clientSocket.end(); upstream.destroy(); });
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    limit(clientSocket, upstream);
    limit(upstream, clientSocket);
    clientSocket.once('close', () => upstream.destroy());
    upstream.once('close', () => clientSocket.destroy());
  });

  // Plain http:// requests arrive in absolute form.
  server.on('request', async (req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400, { Connection: 'close' }); res.end(); return; }
    if (target.protocol !== 'http:') { res.writeHead(400, { Connection: 'close' }); res.end(); return; }
    const port = Number(target.port || 80);
    const verdict = await decide(target.hostname, port);
    if (!verdict.ok) { res.writeHead(403, { Connection: 'close' }); res.end(); return; }
    stats.allowed += 1;

    let socket;
    try {
      socket = await connectAny(verdict.addresses, port, { timeoutMs: settings.EGRESS_CONNECT_TIMEOUT_MS, connect });
    } catch {
      stats.errors += 1;
      res.writeHead(502, { Connection: 'close' });
      res.end();
      return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(name)) headers[name] = value;
    headers.host = target.host;
    // One request on the socket that connectAny already opened. (createConnection is ignored with `agent: false`, so use an agent.)
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    const upstream = http.request({
      method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false, agent, host: target.hostname, port,
      timeout: settings.EGRESS_IDLE_TIMEOUT_MS,
    }, upstreamRes => {
      const out = {};
      for (const [name, value] of Object.entries(upstreamRes.headers)) if (!HOP_BY_HOP.has(name)) out[name] = value;
      res.writeHead(upstreamRes.statusCode, out);
      upstreamRes.pipe(res);
    });
    track(req.socket);
    upstream.on('timeout', () => { stats.timeouts += 1; upstream.destroy(); });
    upstream.on('error', () => { stats.errors += 1; if (!res.headersSent) res.writeHead(502, { Connection: 'close' }); res.end(); });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('clientError', (error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });

  return {
    server,
    stats,
    decide,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    }),
    close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }),
  };
}

module.exports = { createEgressProxy, connectAny };
