'use strict';

const http = require('node:http');
const { isAllowedTarget } = require('./guard');

// The only public listener. Prerender itself runs on a loopback port nothing outside the container can reach, and every request
// passes through here first. This layer exists because Prerender has no limits of its own:
//
//   - Only `GET /<http(s) URL>` is accepted. The /render API (POST, JavaScript injection, PDF and screenshots) is not exposed.
//   - The URL is checked (length, control characters, allowlist) before any browser time is spent on it.
//   - At most MAX_CONCURRENCY pages render at once; MAX_QUEUE more wait for QUEUE_TIMEOUT_MS; the rest get 503 at once.
//   - One request cannot take longer than REQUEST_TIMEOUT_MS or return more than MAX_RESPONSE_BYTES.
//   - Only a short list of response headers and valid status codes are passed on, so the pages being rendered cannot set cookies
//     or security headers for whoever reads the answer.
//   - Errors are short fixed texts. A stack trace or a file path never leaves the container.

const PASS_HEADERS = new Set(['content-type', 'location', 'cache-control', 'expires', 'last-modified', 'etag', 'x-robots-tag', 'content-language', 'vary', 'link', 'retry-after']);
// A rendered page is a full document. 204, 205 and 304 mean "no content" or "use your cached copy"; a page that picks one would
// blank or freeze whatever cache sits behind this service, so they are never passed on.
const NO_BODY_STATUS = new Set([204, 205, 304]);
const CONTROL_IN_PATH = /[\u0000- \u007f]|%(?:[01][0-9a-f]|7f)/i;
const MESSAGES = {
  400: 'Bad request', 403: 'Forbidden', 404: 'Not found', 405: 'Method not allowed', 414: 'URI too long',
  502: 'Bad gateway', 503: 'Service unavailable', 504: 'Gateway timeout',
};
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // The rendered page is for crawlers. If someone opens it in a browser anyway, it must not run or load anything.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
};

function createFront({ config, settings, upstreamPort, logRequests = false, isBrowserConnected, inFlightInBrowser = () => 0, getUtil, log = () => {}, extraMetrics = () => '' }) {
  const stats = {
    requests: 0, rendered: 0, refused: 0, badRequests: 0, queueFull: 0, queueTimeouts: 0, timeouts: 0, upstreamErrors: 0,
    oversize: 0, abandoned: 0, inFlight: 0, maxInFlight: 0, maxQueued: 0,
  };
  const waiting = [];
  let draining = false;

  function reply(res, status, body, headers = {}) {
    if (res.headersSent || res.writableEnded) return;
    const text = body === undefined ? `${MESSAGES[status] || 'Error'}\n` : body;
    const buffer = Buffer.isBuffer(text) ? text : Buffer.from(String(text));
    res.writeHead(status, {
      ...BASE_HEADERS,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buffer.length,
      ...(status >= 500 ? { 'Cache-Control': 'no-store' } : {}),
      ...headers,
    });
    res.end(buffer);
  }

  function acquire(res) {
    return new Promise(resolve => {
      if (stats.inFlight < settings.MAX_CONCURRENCY) { stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); resolve(true); return; }
      if (waiting.length >= settings.MAX_QUEUE) { stats.queueFull += 1; resolve(false); return; }
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const index = waiting.indexOf(entry);
        if (index >= 0) waiting.splice(index, 1);
        stats.queueTimeouts += 1;
        resolve(false);
      }, settings.QUEUE_TIMEOUT_MS);
      waiting.push(entry);
      stats.maxQueued = Math.max(stats.maxQueued, waiting.length);
      // A client that gives up while waiting must not take a slot later.
      res.once('close', () => {
        const index = waiting.indexOf(entry);
        if (index >= 0) { waiting.splice(index, 1); clearTimeout(entry.timer); stats.abandoned += 1; resolve(null); }
      });
    });
  }

  function release() {
    stats.inFlight -= 1;
    const next = waiting.shift();
    if (next) { clearTimeout(next.timer); stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight); next.resolve(true); }
  }

  function render(req, res) {
    const started = Date.now();
    let finished = false;
    let upstream = null;
    const done = () => { if (!finished) { finished = true; clearTimeout(deadline); release(); } };

    const deadline = setTimeout(() => {
      stats.timeouts += 1;
      log(`timed out after ${settings.REQUEST_TIMEOUT_MS}ms`);
      if (upstream) upstream.destroy();
      reply(res, 504);
      done();
    }, settings.REQUEST_TIMEOUT_MS);

    upstream = http.request({
      host: '127.0.0.1', port: upstreamPort, method: 'GET', path: req.url,
      headers: { host: '127.0.0.1', 'accept-encoding': 'identity', connection: 'close' },
      agent: false,
    }, upstreamRes => {
      const chunks = [];
      let size = 0;
      const declared = Number(upstreamRes.headers['content-length']);
      if (Number.isFinite(declared) && declared > settings.MAX_RESPONSE_BYTES) {
        stats.oversize += 1;
        upstream.destroy();
        reply(res, 502);
        done();
        return;
      }
      upstreamRes.on('data', chunk => {
        size += chunk.length;
        if (size > settings.MAX_RESPONSE_BYTES) {
          stats.oversize += 1;
          upstream.destroy();
          reply(res, 502);
          done();
          return;
        }
        chunks.push(chunk);
      });
      upstreamRes.on('end', () => {
        if (finished) return;
        const status = upstreamRes.statusCode;
        if (!(status >= 200 && status <= 599) || NO_BODY_STATUS.has(status)) { stats.upstreamErrors += 1; reply(res, 502); done(); return; }
        const headers = { ...BASE_HEADERS };
        for (const [name, value] of Object.entries(upstreamRes.headers)) if (PASS_HEADERS.has(name)) headers[name] = value;
        if (headers.location !== undefined) {
          const location = Array.isArray(headers.location) ? headers.location[0] : headers.location;
          if (!/^(https?:\/\/|\/)/i.test(location)) delete headers.location;
        }
        const body = Buffer.concat(chunks);
        const type = String(upstreamRes.headers['content-type'] || '');
        headers['content-type'] = /^text\/html/i.test(type) ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8';
        headers['content-length'] = body.length;
        if (!res.headersSent && !res.writableEnded) {
          res.writeHead(status, headers);
          res.end(body);
          stats.rendered += 1;
        }
        done();
        if (logRequests) log(`rendered ${status} ${body.length}B in ${Date.now() - started}ms`);
      });
      upstreamRes.on('error', () => { stats.upstreamErrors += 1; reply(res, 502); done(); });
    });
    upstream.on('error', () => { if (finished) return; stats.upstreamErrors += 1; reply(res, 502); done(); });
    // The client went away: stop waiting for Prerender. The browser tab is closed by Prerender's own timeouts or by the watchdog.
    res.once('close', () => { if (!finished && !res.writableEnded) { stats.abandoned += 1; upstream.destroy(); done(); } });
    upstream.end();
  }

  function metrics() {
    const line = (name, help, type, value) => `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n${name} ${value}\n`;
    return [
      line('prerender_requests_total', 'Requests received', 'counter', stats.requests),
      line('prerender_rendered_total', 'Pages rendered and returned', 'counter', stats.rendered),
      line('prerender_refused_total', 'Requests refused by the host allowlist', 'counter', stats.refused),
      line('prerender_bad_requests_total', 'Requests rejected as malformed', 'counter', stats.badRequests),
      line('prerender_queue_full_total', 'Requests turned away because the queue was full', 'counter', stats.queueFull),
      line('prerender_queue_timeouts_total', 'Requests that waited too long for a slot', 'counter', stats.queueTimeouts),
      line('prerender_timeouts_total', 'Requests cut off at REQUEST_TIMEOUT_MS', 'counter', stats.timeouts),
      line('prerender_upstream_errors_total', 'Renders that failed inside Prerender', 'counter', stats.upstreamErrors),
      line('prerender_oversize_total', 'Responses refused for being too large', 'counter', stats.oversize),
      line('prerender_abandoned_total', 'Requests whose client left before the answer', 'counter', stats.abandoned),
      line('prerender_in_flight', 'Pages rendering now', 'gauge', stats.inFlight),
      line('prerender_queued', 'Requests waiting for a slot', 'gauge', waiting.length),
      line('prerender_browser_tabs', 'Requests Prerender has open in the browser', 'gauge', inFlightInBrowser()),
      line('prerender_browser_connected', '1 when the browser is connected', 'gauge', isBrowserConnected() ? 1 : 0),
      extraMetrics(),
    ].join('');
  }

  function handler(req, res) {
    stats.requests += 1;
    const url = req.url || '';

    if (req.method !== 'GET') {
      stats.badRequests += 1;
      req.resume();
      reply(res, 405, undefined, { Allow: 'GET' });
      return;
    }
    if (url === '/healthz') {
      const ok = isBrowserConnected() && !draining;
      reply(res, ok ? 200 : 503, ok ? 'ok\n' : 'not ready\n', { 'Cache-Control': 'no-store' });
      return;
    }
    if (url === '/metrics' && settings.METRICS_ENABLED) {
      reply(res, 200, metrics(), { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
      return;
    }
    if (url.length > settings.MAX_URL_LENGTH) { stats.badRequests += 1; reply(res, 414); return; }
    if (!/^\/https?:\/\/[^/\s]/i.test(url)) { stats.badRequests += 1; reply(res, /^\/[a-z][a-z0-9+.-]*:/i.test(url) ? 400 : 404); return; }
    if (CONTROL_IN_PATH.test(url)) { stats.badRequests += 1; reply(res, 400); return; }
    // Prerender's own web framework decodes the path and answers a malformed escape with a page that shows a stack trace and
    // file paths. Refuse such a path here, with a fixed text, before it gets that far.
    try { decodeURIComponent(url.split('?')[0]); } catch { stats.badRequests += 1; reply(res, 400); return; }

    let target;
    try { target = getUtil().getUrl(url); } catch { stats.badRequests += 1; reply(res, 400); return; }
    if (!isAllowedTarget(target, config)) {
      stats.refused += 1;
      log(`refused a request for a host that is not allowed: ${JSON.stringify(String(target).slice(0, 120))}`);
      reply(res, 403);
      return;
    }
    if (draining) { reply(res, 503, undefined, { 'Retry-After': '5', Connection: 'close' }); return; }

    acquire(res).then(got => {
      if (got === null) return; // client left while waiting
      if (!got) { reply(res, 503, undefined, { 'Retry-After': '2' }); return; }
      if (res.destroyed || res.writableEnded) { release(); return; }
      render(req, res);
    });
  }

  function createServer() {
    const server = http.createServer({ maxHeaderSize: 8192, keepAliveTimeout: 5000, requestTimeout: 15000, headersTimeout: 10000 }, handler);
    server.maxHeadersCount = 64;
    server.maxConnections = settings.MAX_CONNECTIONS;
    server.on('clientError', (error, socket) => {
      stats.badRequests += 1;
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    return server;
  }

  return {
    stats,
    createServer,
    handler,
    drain: async timeoutMs => {
      draining = true;
      const end = Date.now() + timeoutMs;
      while ((stats.inFlight > 0 || waiting.length > 0) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 100));
      return stats.inFlight === 0;
    },
    get draining() { return draining; },
  };
}

module.exports = { createFront, PASS_HEADERS };
