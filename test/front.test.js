'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const util = require('prerender/lib/util');
const { createFront } = require('../lib/front');
const { loadSettings } = require('../lib/settings');

const config = { allowedHosts: ['site.example'], allowAnyHost: false, allowPrivate: false };

async function setup(overrides = {}, upstreamHandler) {
  const settings = loadSettings({ MAX_CONCURRENCY: '2', MAX_QUEUE: '2', QUEUE_TIMEOUT_MS: '400', PAGE_LOAD_TIMEOUT_MS: '1000', REQUEST_TIMEOUT_MS: '2000', TAB_MAX_AGE_MS: '5000', METRICS_ENABLED: 'true', MAX_RESPONSE_BYTES: '4096', ...overrides });
  const calls = [];
  const upstream = http.createServer((req, res) => { calls.push(req.url); upstreamHandler(req, res); });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  let connected = true;
  const front = createFront({ config, settings, upstreamPort: upstream.address().port, isBrowserConnected: () => connected, getUtil: () => util });
  const server = front.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const get = (path, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method, agent: false }, res => {
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  const close = async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); upstream.closeAllConnections?.(); await new Promise(r => upstream.close(r)); };
  return { front, settings, calls, get, close, setConnected: v => { connected = v; }, port: () => server.address().port };
}
const ok = (body = '<html>ok</html>', headers = {}) => (req, res) => { res.writeHead(200, { 'content-type': 'text/html', ...headers }); res.end(body); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('a render is passed through and only safe headers are kept', async () => {
  const s = await setup({}, ok('<html>page</html>', { 'set-cookie': 'sid=1', 'x-internal': 'a', etag: '"abc"', 'x-robots-tag': 'noindex', 'content-security-policy': "default-src 'none'" }));
  try {
    const r = await s.get('/https://site.example/a/b?c=d');
    assert.equal(r.status, 200);
    assert.equal(r.body, '<html>page</html>');
    assert.equal(r.headers.etag, '"abc"');
    assert.equal(r.headers['x-robots-tag'], 'noindex');
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.headers['x-internal'], undefined);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.match(r.headers['content-security-policy'], /sandbox/);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.deepEqual(s.calls, ['/https://site.example/a/b?c=d'], 'the original path reaches Prerender unchanged');
  } finally { await s.close(); }
});

test('bad requests are refused before Prerender sees them, with fixed short texts', async () => {
  const s = await setup({ MAX_URL_LENGTH: '200' }, ok());
  try {
    const cases = [
      ['/', 404], ['/favicon.ico', 404], ['/render?url=https://site.example/', 404], ['/ftp://site.example/', 400], ['/file:///etc/passwd', 400], ['/javascript:alert(1)', 400],
      ['/https://site.example/%zz', 400], ['/https://site.example/%c0%af', 400], ['/https://site.example/%00', 400], ['/https://site.example/a%0d%0aX:1', 400], ['/https://site.example/%7f', 400],
      ['/https://evil.example/', 403], ['/https://site.example.evil.example/', 403], ['/https://site.example@evil.example/', 403], ['/http://169.254.169.254/', 403], ['/https://localhost/', 403],
      [`/https://site.example/${'a'.repeat(300)}`, 414],
    ];
    for (const [path, status] of cases) {
      const r = await s.get(path);
      assert.equal(r.status, status, path);
      assert.doesNotMatch(r.body, /at .*\(|node_modules|\/home\/|\/tmp\/|Error:/, `${path} leaked internals: ${r.body.slice(0, 100)}`);
      assert.ok(r.body.length < 40, `${path} body should be a short fixed text`);
    }
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
      const r = await s.get('/https://site.example/', { method });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.allow, 'GET');
    }
    assert.deepEqual(s.calls, [], 'nothing reached Prerender');
  } finally { await s.close(); }
});

test('only MAX_CONCURRENCY pages render at once, the next wait, and the rest are turned away at once', async () => {
  let active = 0; let peak = 0; const releases = [];
  const s = await setup({ QUEUE_TIMEOUT_MS: '5000' }, (req, res) => { active += 1; peak = Math.max(peak, active); releases.push(() => { active -= 1; res.writeHead(200, { 'content-type': 'text/html' }); res.end('done'); }); });
  try {
    const all = Array.from({ length: 6 }, (_, i) => s.get(`/https://site.example/${i}`));
    await sleep(300);
    assert.equal(active, 2, 'two render');
    assert.equal(s.front.stats.queueFull, 2, 'two are queued, two are turned away');
    while (releases.length) { releases.shift()(); await sleep(100); }
    const results = await Promise.all(all);
    const statuses = results.map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 503, 503]);
    assert.equal(peak, 2, 'never more than two in the browser');
    assert.equal(results.find(r => r.status === 503).headers['retry-after'], '2');
  } finally { await s.close(); }
});

test('a request that waits too long for a slot gets 503', async () => {
  const s = await setup({ MAX_CONCURRENCY: '1', QUEUE_TIMEOUT_MS: '300' }, () => { /* never answers */ });
  try {
    const first = s.get('/https://site.example/1');
    await sleep(100);
    const second = await s.get('/https://site.example/2');
    assert.equal(second.status, 503);
    assert.equal(s.front.stats.queueTimeouts, 1);
    first.catch(() => {});
  } finally { await s.close(); }
});

test('a render that takes too long is cut off with 504 and frees its slot', async () => {
  const s = await setup({ MAX_CONCURRENCY: '1', PAGE_LOAD_TIMEOUT_MS: '1000', REQUEST_TIMEOUT_MS: '1500', TAB_MAX_AGE_MS: '5000' }, (req, res) => { if (req.url.endsWith('/hang')) return; ok()(req, res); });
  try {
    const t = Date.now();
    const slow = await s.get('/https://site.example/hang');
    assert.equal(slow.status, 504);
    assert.ok(Date.now() - t < 3000, `answered in ${Date.now() - t} ms`);
    assert.equal(s.front.stats.inFlight, 0, 'the slot was released');
    assert.equal((await s.get('/https://site.example/fine')).status, 200, 'the next request is served');
  } finally { await s.close(); }
});

test('an oversized page is refused, whether the length is declared or only streamed', async () => {
  const s = await setup({ MAX_RESPONSE_BYTES: '2048' }, (req, res) => {
    res.writeHead(200, req.url.endsWith('/declared') ? { 'content-type': 'text/html', 'content-length': '999999' } : { 'content-type': 'text/html' });
    if (req.url.endsWith('/declared')) res.end('x'.repeat(10)); else { res.write('y'.repeat(1500)); res.write('y'.repeat(1500)); res.end('y'.repeat(1500)); }
  });
  try {
    assert.equal((await s.get('/https://site.example/declared')).status, 502);
    assert.equal((await s.get('/https://site.example/streamed')).status, 502);
    assert.equal(s.front.stats.oversize, 2);
  } finally { await s.close(); }
});

test('status codes: real ones pass, "no content" and nonsense become 502', async () => {
  const s = await setup({}, (req, res) => { const code = Number(req.url.split('/').pop()); res.writeHead(code, { 'content-type': 'text/html' }); res.end(code === 204 || code === 304 ? undefined : 'x'); });
  try {
    for (const code of [200, 301, 404, 410, 500, 503, 504]) assert.equal((await s.get(`/https://site.example/${code}`)).status, code);
    for (const code of [204, 205, 304]) assert.equal((await s.get(`/https://site.example/${code}`)).status, 502, String(code));
  } finally { await s.close(); }
});

test('a Location header is kept only when it is http, https or a path', async () => {
  const loc = { good: 'https://example.com/new', rel: '/new', js: 'javascript:alert(1)', data: 'data:text/html,x' };
  const s = await setup({}, (req, res) => { res.writeHead(301, { 'content-type': 'text/html', location: loc[req.url.split('/').pop()] }); res.end('moved'); });
  try {
    assert.equal((await s.get('/https://site.example/good')).headers.location, loc.good);
    assert.equal((await s.get('/https://site.example/rel')).headers.location, loc.rel);
    assert.equal((await s.get('/https://site.example/js')).headers.location, undefined);
    assert.equal((await s.get('/https://site.example/data')).headers.location, undefined);
  } finally { await s.close(); }
});

test('an upstream that closes the connection or sends garbage gives a clean 502', async () => {
  const s = await setup({}, (req, res) => { if (req.url.endsWith('/drop')) req.socket.destroy(); else { res.socket.write('NOT HTTP\r\n\r\n'); res.socket.destroy(); } });
  try {
    assert.equal((await s.get('/https://site.example/drop')).status, 502);
    assert.equal((await s.get('/https://site.example/garbage')).status, 502);
    assert.equal(s.front.stats.inFlight, 0);
  } finally { await s.close(); }
});

test('a client that leaves while queued or rendering gives its slot back', async () => {
  const releases = [];
  const s = await setup({ MAX_CONCURRENCY: '1', QUEUE_TIMEOUT_MS: '5000' }, (req, res) => { releases.push(res); });
  try {
    const abandon = path => new Promise(resolve => { const sock = net.connect(s.port(), '127.0.0.1', () => { sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`); setTimeout(() => { sock.destroy(); resolve(); }, 150); }); });
    await abandon('/https://site.example/1');
    await abandon('/https://site.example/2');
    await sleep(300);
    assert.equal(s.front.stats.inFlight, 0, 'no slot is held for clients that are gone');
    assert.ok(s.front.stats.abandoned >= 1);
  } finally { releases.forEach(r => r.destroy()); await s.close(); }
});

test('health reflects the browser and draining; metrics are only served when enabled', async () => {
  const s = await setup({}, ok());
  try {
    assert.equal((await s.get('/healthz')).status, 200);
    s.setConnected(false);
    assert.equal((await s.get('/healthz')).status, 503);
    s.setConnected(true);
    const m = await s.get('/metrics');
    assert.equal(m.status, 200);
    assert.match(m.body, /prerender_in_flight 0/);
    assert.match(m.body, /prerender_browser_connected 1/);
    await s.front.drain(10);
    assert.equal((await s.get('/healthz')).status, 503, 'not ready while draining');
    const r = await s.get('/https://site.example/');
    assert.equal(r.status, 503, 'new work is refused while draining');
  } finally { await s.close(); }
  const off = await setup({ METRICS_ENABLED: 'false' }, ok());
  try { assert.equal((await off.get('/metrics')).status, 404); } finally { await off.close(); }
});

test('drain waits for running requests', async () => {
  let finish;
  const s = await setup({}, (req, res) => { finish = () => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('late'); }; });
  try {
    const running = s.get('/https://site.example/slow');
    await sleep(150);
    const drained = s.front.drain(3000);
    await sleep(200);
    finish();
    assert.equal((await running).body, 'late', 'the running request finished normally');
    assert.equal(await drained, true);
  } finally { await s.close(); }
});

test('raw protocol abuse is answered or closed without a crash', async () => {
  const s = await setup({}, ok());
  try {
    const raw = payload => new Promise(resolve => { const sock = net.connect(s.port(), '127.0.0.1', () => sock.write(payload)); let d = ''; sock.on('data', x => { d += x; }); sock.on('close', () => resolve(d)); sock.on('error', () => resolve(d)); setTimeout(() => { sock.destroy(); resolve(d); }, 700); });
    assert.match(await raw('GARBAGE\r\n\r\n'), /400|^$/);
    assert.match(await raw(`GET /${'a'.repeat(20000)} HTTP/1.1\r\nHost: x\r\n\r\n`), /431|400|^$/);
    assert.match(await raw('GET /https://site.example/ HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'), /400|^$/);
    assert.equal((await s.get('/healthz')).status, 200, 'still serving');
  } finally { await s.close(); }
});
