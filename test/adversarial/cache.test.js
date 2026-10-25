'use strict';

// The render cache against a real browser: a clean page is kept and served again without touching the site or the browser, and a
// render that is not clean (page-load timeout, a failing request of the page's own, a non-200 status) is never kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service, Site, request, skipReason } = require('../lab/lab');

const ENV = {
  MAX_CONCURRENCY: '2', MAX_QUEUE: '4', PAGE_LOAD_TIMEOUT_MS: '2500', REQUEST_TIMEOUT_MS: '6000', TAB_MAX_AGE_MS: '9000',
  BROWSER_MAX_RSS_MB: '3000', METRICS_ENABLED: 'true', CACHE_TTL_S: '60', CACHE_MAX_MB: '16',
};
let service; let site;

test.before(async () => {
  if (skipReason) return;
  site = await new Site('127.0.0.1').start();
  site.html('/clean', '<!doctype html><title>clean</title><body><div id=o>x</div><script>document.getElementById("o").textContent="clean page rendered"</script>');
  site.html('/hangs', '<!doctype html><title>hangs</title><body><div id=o>x</div><script>document.getElementById("o").textContent="hanging page rendered";fetch("/never")</script>');
  site.route('/never', () => { /* the request is never answered */ });
  site.html('/fails', '<!doctype html><title>fails</title><body><div id=o>x</div><script>document.getElementById("o").textContent="page with a failing request";fetch("/broken")</script>');
  site.route('/broken', (req, res) => { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('no'); });
  site.html('/missing', '<!doctype html><html><head><meta name="prerender-status-code" content="404"><title>x</title></head><body>gone</body></html>');
  service = await new Service(ENV).start();
});
test.after(async () => { if (skipReason) return; await service.stop(); await site.stop(); });

const skip = skipReason || false;
const render = route => service.render(site.url(route), { timeout: 30000 });
const metric = async name => Number(((await request(`${service.url}/metrics`)).body.match(new RegExp(`^${name} (\\d+)`, 'm')) || [])[1]);

test('a clean page is rendered once and then served from the cache', { skip, timeout: 60000 }, async () => {
  const first = await render('/clean');
  assert.equal(first.status, 200);
  assert.match(first.body, /clean page rendered/);
  assert.equal(first.headers['x-prerender-cache'], 'miss');
  assert.equal(site.hitsFor('/clean').length, 1);
  const second = await render('/clean');
  assert.equal(second.status, 200);
  assert.equal(second.headers['x-prerender-cache'], 'hit');
  assert.equal(second.body, first.body, 'the cached answer is the rendered answer');
  assert.equal(second.headers['x-prerender-complete'], undefined, 'the internal marker is not passed on');
  assert.equal(site.hitsFor('/clean').length, 1, 'the site was not asked again');
  assert.ok(second.ms < 500, `a cached answer takes ${second.ms} ms`);
  assert.ok(await metric('prerender_cache_hits_total') >= 1);
  const other = await render('/clean?x=1');
  assert.equal(other.headers['x-prerender-cache'], 'miss', 'another query string is another page');
  assert.equal(site.hitsFor('/clean').length, 2);
});

test('a page that hit the page-load timeout is not kept', { skip, timeout: 60000 }, async () => {
  const first = await render('/hangs');
  assert.equal(first.status, 200);
  assert.match(first.body, /hanging page rendered/);
  assert.equal(first.headers['x-prerender-cache'], 'miss');
  const second = await render('/hangs');
  assert.equal(second.headers['x-prerender-cache'], 'miss', 'rendered again, because the first render did not finish cleanly');
  assert.equal(site.hitsFor('/hangs').length, 2);
});

test('a page whose own request failed with 5xx is not kept', { skip, timeout: 60000 }, async () => {
  const first = await render('/fails');
  assert.equal(first.status, 200);
  const second = await render('/fails');
  assert.equal(second.headers['x-prerender-cache'], 'miss');
  assert.equal(site.hitsFor('/fails').length, 2);
});

test('a page with another status is not kept', { skip, timeout: 60000 }, async () => {
  const first = await render('/missing');
  assert.equal(first.status, 404);
  const second = await render('/missing');
  assert.equal(second.status, 404);
  assert.notEqual(second.headers['x-prerender-cache'], 'hit');
  assert.equal(site.hitsFor('/missing').length, 2);
});

test('the service still renders and is healthy', { skip, timeout: 60000 }, async () => {
  assert.equal((await request(`${service.url}/healthz`)).status, 200);
  const res = await render('/clean?after=1');
  assert.match(res.body, /clean page rendered/);
});
