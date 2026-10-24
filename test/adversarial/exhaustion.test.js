'use strict';

// Resource exhaustion: a hostile or broken page, or a flood of callers, must not take the service down, grow it without bound,
// or leave work behind. Every test ends by proving the service still renders a normal page.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service, Site, request, sleep, skipReason, EXTERNAL } = require('../lab/lab');

const ENV = {
  MAX_CONCURRENCY: '3', MAX_QUEUE: '6', QUEUE_TIMEOUT_MS: '2500', PAGE_LOAD_TIMEOUT_MS: '3000', REQUEST_TIMEOUT_MS: '6000', TAB_MAX_AGE_MS: '9000',
  BROWSER_MAX_RSS_MB: '3000', METRICS_ENABLED: 'true', MAX_RESPONSE_BYTES: String(2 * 1024 * 1024),
};
let service; let site;
const noDebug = skipReason || (EXTERNAL ? 'needs the service process' : false);

test.before(async () => {
  if (skipReason) return;
  site = await new Site('127.0.0.1').start();
  site.html('/ok', '<!doctype html><title>ok</title><body><div id=o>x</div><script>document.getElementById("o").textContent="rendered fine"</script>');
  service = await new Service(ENV).start();
  bootTabs = await openTabs();
});
let bootTabs = 0;
test.afterEach(t => { if (service && !EXTERNAL && (!service.alive() || t.passed === false)) console.log(`# service log tail (alive: ${service.alive()}):\n${service.log.split('\n').slice(-30).map(l => `#   ${l}`).join('\n')}`); });
test.after(async () => { if (skipReason) return; await service.stop(); await site.stop(); });

const render = (route, timeout = 40000) => service.render(site.url(route), { timeout });
async function stillWorks(label) {
  const res = await render('/ok');
  assert.equal(res.status, 200, `${label}: a normal page no longer renders (${res.status} ${res.error || ''})`);
  assert.match(res.body, /rendered fine/, label);
  assert.equal((await request(`${service.url}/healthz`)).status, 200, `${label}: unhealthy`);
}
async function waitFor(fn, ms = 20000, step = 250) {
  const end = Date.now() + ms;
  let value;
  while (Date.now() < end) { value = await fn(); if (value) return value; await sleep(step); }
  return value;
}
const openTabs = async () => ((await service.targets()) || []).length;

test('a flood of callers is queued, then turned away at once; the browser never runs more tabs than allowed', { skip: skipReason, timeout: 120000 }, async () => {
  site.route('/slow', (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>s</title><body>slow ok</body>'); }, 600); });
  let peak = 0; let polling = !EXTERNAL;
  const poll = (async () => { while (polling) { peak = Math.max(peak, await openTabs()); await sleep(80); } })();
  const t0 = Date.now();
  const all = await Promise.all(Array.from({ length: 80 }, (_, i) => render(`/slow?i=${i}`, 60000)));
  polling = false; await poll;
  const counts = {};
  for (const r of all) counts[r.status || r.error] = (counts[r.status || r.error] || 0) + 1;
  assert.ok(Object.keys(counts).every(k => ['200', '503'].includes(k)), `unexpected answers: ${JSON.stringify(counts)}`);
  assert.ok(counts[200] >= 3, `only ${counts[200]} pages were rendered`);
  assert.ok(counts[503] >= 50, `the overload was not shed: ${JSON.stringify(counts)}`);
  const shed = all.filter(r => r.status === 503).map(r => r.ms).sort((a, b) => a - b);
  assert.ok(shed[Math.floor(shed.length / 2)] < 3500, 'turned-away callers should be answered quickly');
  // 3 rendering + the tab the browser starts with + one whose close is still in progress
  if (!EXTERNAL) assert.ok(peak <= 3 + 2, `the browser had ${peak} tabs open at once (limit 3)`);
  console.log(`# flood: ${JSON.stringify(counts)} in ${Date.now() - t0} ms, peak tabs ${peak}`);
  await stillWorks('after the flood');
});

test('pages that never finish loading are cut off and their tabs do not pile up', { skip: skipReason, timeout: 180000 }, async () => {
  site.route('/hang', () => { /* never answers */ });
  site.html('/never-ready', '<!doctype html><title>x</title><body>keeps going<script>setInterval(()=>fetch("/tick?"+Math.random()).catch(()=>{}),20)</script>');
  site.route('/tick', (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('t'); });
    for (const route of ['/hang', '/never-ready', '/hang', '/never-ready']) {
    const res = await render(route);
    assert.ok([200, 504].includes(res.status), `${route}: ${res.status} ${res.error || ''}`);
    assert.ok(res.ms < 6000 + 2500, `${route}: took ${res.ms} ms (deadline 6000)`);
  }
  if (!EXTERNAL) assert.ok(await waitFor(async () => (await openTabs()) <= bootTabs, 15000), `tabs left behind: ${await openTabs()} (boot ${bootTabs})`);
  await stillWorks('after hanging pages');
});

test('a page stuck in an endless loop is cut off, and the browser recovers', { skip: skipReason, timeout: 180000 }, async () => {
  site.html('/spin', '<!doctype html><title>spin</title><body><script>while(true){}</script>');
  site.html('/spin-later', '<!doctype html><title>spin</title><body>hi<script>setTimeout(()=>{while(true){}},300)</script>');
  for (const route of ['/spin', '/spin-later', '/spin']) {
    const res = await render(route);
    assert.ok(res.status && res.ms < 6000 + 3000, `${route}: ${res.status} ${res.error} after ${res.ms} ms`);
  }
  if (!EXTERNAL) assert.ok(await waitFor(async () => (await openTabs()) <= bootTabs, 20000), `tabs left behind: ${await openTabs()} (boot ${bootTabs})`);
  await stillWorks('after endless loops');
});

test('a page that eats memory crashes only itself, and memory comes back', { skip: noDebug, timeout: 180000 }, async () => {
  site.html('/eat', '<!doctype html><title>eat</title><body><script>const keep=[];(function f(){keep.push(new Array(5e6).fill(1.5));setTimeout(f,0)})()</script>');
  const before = service.rssMB();
  for (let i = 0; i < 3; i += 1) {
    const res = await render('/eat');
    assert.ok(res.status, `no answer (${res.error})`);
    assert.ok(res.ms < 6000 + 3000, `took ${res.ms} ms`);
  }
  await sleep(1500);
  const after = service.rssMB();
  assert.ok(after < before + 1200, `memory grew from ${Math.round(before)} to ${Math.round(after)} MB`);
  await stillWorks('after memory bombs');
});

test('oversized results are refused, whether built by the page or served compressed', { skip: skipReason, timeout: 180000 }, async () => {
  site.html('/build-big', '<!doctype html><title>big</title><body><script>document.body.textContent="x".repeat(5*1024*1024)</script>');
  site.route('/gzip-bomb', (req, res) => {
    const zlib = require('node:zlib');
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(Buffer.from(`<!doctype html><title>b</title><body>${'a'.repeat(40 * 1024 * 1024)}</body>`)));
  });
  site.route('/endless', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<!doctype html><title>e</title><body>'); const t = setInterval(() => res.write('a'.repeat(65536)), 5); res.on('close', () => clearInterval(t)); });
  for (const route of ['/build-big', '/gzip-bomb', '/endless']) {
    const res = await render(route);
    assert.ok([502, 504].includes(res.status), `${route} answered ${res.status} (${res.body && res.body.length} bytes)`);
    assert.ok(!res.buffer || res.buffer.length < 2 * 1024 * 1024 + 200, `${route} returned ${res.buffer && res.buffer.length} bytes`);
  }
  await stillWorks('after oversized pages');
});

test('a page cannot flood the network, open pop-ups, loop dialogs or start downloads', { skip: skipReason, timeout: 180000 }, async () => {
  site.route('/count', (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('1'); });
  site.html('/fetch-storm', '<!doctype html><title>f</title><body>storm<script>for(let i=0;i<3000;i++)fetch("/count?"+i).catch(()=>{})</script>');
  site.html('/popups', '<!doctype html><title>p</title><body>pop<script>setInterval(()=>{window.open("/ok");window.open("about:blank")},10)</script>');
  site.html('/dialogs', '<!doctype html><title>d</title><body>dlg<script>setInterval(()=>{alert("a");confirm("c");prompt("p")},5)</script>');
  site.html('/frames', `<!doctype html><title>fr</title><body>${'<iframe src="/ok"></iframe>'.repeat(150)}`);
  site.route('/file.bin', (req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=a.bin' }); res.end(Buffer.alloc(5 * 1024 * 1024)); });
  site.html('/download', '<!doctype html><title>dl</title><body>dl<script>const a=document.createElement("a");a.href="/file.bin";a.download="a.bin";document.body.appendChild(a);a.click();location.href="/file.bin"</script>');
  for (const route of ['/fetch-storm', '/popups', '/dialogs', '/frames', '/download']) {
    const res = await render(route);
    assert.ok(res.status && res.status < 600, `${route}: ${res.status} ${res.error || ''}`);
    assert.ok(res.ms < 6000 + 3000, `${route}: took ${res.ms} ms`);
  }
  if (!EXTERNAL) assert.ok(await waitFor(async () => (await openTabs()) <= bootTabs, 20000), `pop-ups or tabs left behind: ${await openTabs()} (boot ${bootTabs})`);
  await stillWorks('after the abuse');
});

test('an origin that sends one byte at a time cannot hold a slot past the deadline', { skip: skipReason, timeout: 120000 }, async () => {
  site.route('/drip', (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<!doctype html><title>d</title><body>'); const t = setInterval(() => res.write('.'), 300); res.on('close', () => clearInterval(t)); });
  const started = Date.now();
  const res = await render('/drip');
  assert.ok([200, 502, 504].includes(res.status), `status ${res.status}`);
  assert.ok(Date.now() - started < 6000 + 2500, `held a slot for ${Date.now() - started} ms`);
  await stillWorks('after the slow origin');
});

test('metrics add up after all of the above', { skip: skipReason, timeout: 30000 }, async () => {
  const m = await request(`${service.url}/metrics`);
  assert.equal(m.status, 200);
  const value = name => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(m.body)[1]);
  assert.equal(value('prerender_in_flight'), 0, 'nothing is still running');
  assert.equal(value('prerender_queued'), 0);
  assert.ok(value('prerender_queue_full_total') > 0, 'the flood was counted');
  assert.ok(value('prerender_timeouts_total') + value('prerender_upstream_errors_total') > 0, 'the cut-off pages were counted');
  assert.equal(value('prerender_browser_connected'), 1);
});
