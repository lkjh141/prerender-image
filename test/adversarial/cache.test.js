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
  // A hostile page tries to make its own incomplete render look complete, so that it is kept and served to everyone.
  site.html('/forged', '<!doctype html><html><head><meta name="prerender-header" content="x-prerender-complete: 1"><meta name="prerender-header" content="cache-control: public, max-age=9999"><meta name="prerender-header" content="x-prerender-cache: hit"><title>f</title></head><body><div id=o>x</div><script>document.getElementById("o").textContent="forged page rendered";fetch("/never")</script></body></html>');
  site.html('/slow', '<!doctype html><title>slow</title><body><div id=o>x</div><script>setTimeout(function(){document.getElementById("o").textContent="slow page rendered"},200)</script>');
  site.html('/slow-hangs', '<!doctype html><title>sh</title><body><div id=o>x</div><script>document.getElementById("o").textContent="slow hanging page";fetch("/never")</script>');
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

test('a page cannot forge the completeness marker or the cache headers with prerender-header tags', { skip, timeout: 60000 }, async () => {
  const first = await render('/forged');
  assert.equal(first.status, 200);
  assert.match(first.body, /forged page rendered/);
  assert.equal(first.headers['x-prerender-cache'], 'miss', 'the cache header comes from the service, not from the page');
  assert.equal(first.headers['x-prerender-complete'], undefined);
  const second = await render('/forged');
  assert.equal(second.headers['x-prerender-cache'], 'miss', 'an incomplete render is not kept just because the page says it is complete');
  assert.equal(site.hitsFor('/forged').length, 2);
});

test('a burst of callers for the same uncached page costs one render, not one each', { skip, timeout: 90000 }, async () => {
  const answers = await Promise.all(Array.from({ length: 12 }, () => render('/slow')));
  assert.ok(answers.every(a => a.status === 200 && /slow page rendered/.test(a.body)), 'every caller got the finished page');
  assert.equal(site.hitsFor('/slow').length, 1, 'the site was asked once');
  assert.ok(answers.filter(a => a.headers['x-prerender-cache'] === 'hit').length >= 11, 'the others were served from the cache');
  assert.ok(await metric('prerender_coalesced_total') >= 11);
});

test('a burst for a page that cannot be kept still answers every caller', { skip, timeout: 90000 }, async () => {
  const answers = await Promise.all(Array.from({ length: 6 }, () => render('/slow-hangs')));
  assert.ok(answers.every(a => a.status === 200 && /slow hanging page/.test(a.body)), JSON.stringify(answers.map(a => a.status)));
  assert.equal(await metric('prerender_in_flight'), 0, 'no slot is left taken');
});

test('callers that leave while waiting for the first render do not break it', { skip, timeout: 60000 }, async () => {
  const leavers = Array.from({ length: 5 }, () => request(`${service.url}/${site.url('/slow?leave')}`, { timeout: 150 }));
  const stayer = render('/slow?leave');
  await Promise.all(leavers);
  const answer = await stayer;
  assert.equal(answer.status, 200);
  assert.match(answer.body, /slow page rendered/);
  assert.equal(await metric('prerender_in_flight'), 0);
});
