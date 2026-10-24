'use strict';

// What comes back to the caller. A rendered page is untrusted input: it must not be able to inject response headers, forge a
// status, plant cookies, or break the response encoding, and a bad certificate must not be waved through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const zlib = require('node:zlib');
const { Service, Site, request, listen, selfSigned, skipReason } = require('../lab/lab');

let service; let site;
test.before(async () => {
  if (skipReason) return;
  site = await new Site('127.0.0.1').start();
  service = await new Service().start();
});
test.after(async () => { if (skipReason) return; await service.stop(); await site.stop(); });

const page = (head, body = 'content') => `<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;
const meta = (name, content) => `<meta name="${name}" content="${content}">`;
let n = 0;
async function renderMarkup(markup, headers = {}) {
  const route = `/r${++n}`;
  site.route(route, (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(markup); });
  return service.render(site.url(route), { timeout: 60000 });
}

test('a page cannot inject response headers with line breaks', { skip: skipReason, timeout: 120000 }, async () => {
  const res = await renderMarkup(page(meta('prerender-header', 'X-Test: ok&#13;&#10;Set-Cookie: pwned=1&#13;&#10;X-Injected: yes')));
  assert.ok(res.status, 'it still answered');
  assert.equal(res.headers['set-cookie'], undefined, 'a header was injected');
  assert.equal(res.headers['x-injected'], undefined, 'a header was injected');
});

test('a page cannot set cookies, security policy or framing headers on the response', { skip: skipReason, timeout: 120000 }, async () => {
  const res = await renderMarkup(page([
    meta('prerender-header', 'Set-Cookie: session=forged; Path=/'),
    meta('prerender-header', 'Content-Security-Policy: default-src none'),
    meta('prerender-header', 'Strict-Transport-Security: max-age=0'),
    meta('prerender-header', 'Access-Control-Allow-Origin: *'),
    meta('prerender-header', 'Content-Length: 3'),
    meta('prerender-header', 'Transfer-Encoding: chunked'),
    meta('prerender-header', 'Content-Encoding: gzip'),
  ].join('')));
  for (const name of ['set-cookie', 'strict-transport-security', 'access-control-allow-origin']) {
    assert.equal(res.headers[name], undefined, `${name} was set by the page`);
  }
  assert.doesNotMatch(String(res.headers['content-security-policy']), /default-src none/, 'the page replaced the service\'s own policy');
  assert.notEqual(res.headers['content-encoding'], 'gzip', 'the page changed the content encoding');
  assert.match(res.body, /content/, 'the body is intact (a forged length would cut it)');
});

test('a page can still set a redirect target and a robots header', { skip: skipReason, timeout: 120000 }, async () => {
  const res = await renderMarkup(page(meta('prerender-status-code', '301') + meta('prerender-header', 'Location: https://example.com/new') + meta('prerender-header', 'X-Robots-Tag: noindex')));
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, 'https://example.com/new');
  assert.equal(res.headers['x-robots-tag'], 'noindex');
});

test('a page cannot choose a nonsensical status code', { skip: skipReason, timeout: 180000 }, async () => {
  for (const code of ['101', '204', '205', '304', '0', '99', '600', '999', 'abc', '200 OK', '-1']) {
    const res = await renderMarkup(page(meta('prerender-status-code', code)));
    assert.ok(res.status >= 200 && res.status <= 599 && ![101, 204, 205, 304].includes(res.status), `status "${code}" produced ${res.status}`);
  }
  assert.equal((await renderMarkup(page(meta('prerender-status-code', '404')))).status, 404, 'a real 404 still works');
});

test('cookies and other headers from the rendered site are not passed on to the caller', { skip: skipReason, timeout: 120000 }, async () => {
  const res = await renderMarkup(page('', 'cookie test'), {
    'set-cookie': ['sid=SECRET-SESSION; Path=/; HttpOnly', 'tracker=1'],
    'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY', 'strict-transport-security': 'max-age=31536000',
    'access-control-allow-origin': '*', 'x-served-by': 'origin-7',
  });
  assert.equal(res.headers['set-cookie'], undefined, 'the site\'s cookie reached the caller');
  assert.notEqual(res.headers['content-security-policy'], "default-src 'none'", 'the site\'s policy was copied onto the rendered copy');
  assert.equal(res.headers['x-frame-options'], undefined, 'the site\'s framing header was copied onto the rendered copy');
  assert.equal(res.headers['x-served-by'], undefined, 'an internal header leaked');
});

test('the response encoding is honest even when the site compresses its page', { skip: skipReason, timeout: 120000 }, async () => {
  const route = '/gz';
  site.route(route, (req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }); res.end(zlib.gzipSync(page('', 'gzip site content'))); });
  for (const accept of ['gzip', 'identity', '']) {
    const res = await request(`${service.url}/${site.url(route)}`, { headers: { 'accept-encoding': accept, 'user-agent': 'Googlebot' }, timeout: 60000 });
    const encoding = res.headers['content-encoding'];
    const text = encoding === 'gzip' ? zlib.gunzipSync(res.buffer).toString() : res.buffer.toString();
    assert.match(text, /gzip site content/, `Accept-Encoding "${accept}": the body does not match its Content-Encoding "${encoding}"`);
  }
});

test('a certificate that does not validate is not accepted', { skip: skipReason, timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const secure = https.createServer(selfSigned(dir), (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('', 'TLS-SERVED-CONTENT')); });
  const port = await listen(secure);
  try {
    const res = await service.render(`https://127.0.0.1:${port}/`, { timeout: 60000 });
    assert.doesNotMatch(res.body || '', /TLS-SERVED-CONTENT/, 'a page behind an untrusted certificate was rendered and returned');
  } finally { secure.closeAllConnections?.(); secure.close(); }
});
