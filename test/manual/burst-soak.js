'use strict';

// A long soak with the render cache and the burst coalescing switched on. Not part of `npm test` (it takes SOAK_MINUTES, default 30).
//   CHROME_BIN=/path/to/chromium SOAK_MINUTES=30 node test/manual/burst-soak.js
// Each round: a burst of callers for one new page, a mixed load of ordinary and hostile pages, and repeat requests for cached pages.
// Every minute it records memory, descriptors, processes, tabs, the browser profile size and the cache, and at the end it compares the
// second half of the run with the first half. Exit code 1 when something grew without bound or an answer was wrong.
const { Service, Site, sleep, dirSizeMB, request } = require('../lab/lab');
const { treeRssMb } = require('../../lib/watchdog');

const MINUTES = Number(process.env.SOAK_MINUTES || 30);
const ENV = {
  MAX_CONCURRENCY: '4', MAX_QUEUE: '64', PAGE_LOAD_TIMEOUT_MS: '3000', REQUEST_TIMEOUT_MS: '8000', TAB_MAX_AGE_MS: '9000', METRICS_ENABLED: 'true',
  CACHE_TTL_S: '30', CACHE_MAX_ENTRIES: '40', CACHE_MAX_MB: '8', QUEUE_TIMEOUT_MS: '30000', NODE_OPTIONS: '--max-old-space-size=384',
};

(async () => {
  const site = await new Site('127.0.0.1').start();
  site.html('/simple', '<!doctype html><title>simple</title><body><h1>Hello</h1><p>static</p>');
  site.html('/spa', '<!doctype html><title>spa</title><body><div id=app>loading</div><script>fetch("/api").then(r=>r.json()).then(d=>{document.getElementById("app").textContent="spa "+d.items.length})</script>');
  site.route('/api', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => i) })); });
  site.html('/hang-ish', '<!doctype html><title>x</title><body>x<script>setInterval(()=>fetch("/api"),10)</script>');
  site.html('/alert', '<!doctype html><title>x</title><body>x<script>alert(1);alert(2)</script>');
  site.html('/popup', '<!doctype html><title>x</title><body>x<script>window.open("/simple")</script>');
  site.html('/never', '<!doctype html><title>x</title><body>x<script>fetch("/hole")</script>');
  site.route('/hole', () => {});
  const svc = await new Service(ENV).start();
  const metric = async name => { const m = await request(`${svc.url}/metrics`); const x = new RegExp(`^${name} (\\d+)`, 'm').exec(m.body || ''); return x ? Number(x[1]) : NaN; };
  const browserMain = () => svc.processes().find(p => p.ppid === svc.pid && /chrom/i.test(p.args));
  const snapshot = async () => ({
    min: Math.round((Date.now() - start) / 60000), nodeMB: svc.nodeRssMB(), heapMB: await metric('prerender_node_heap_used_mb'), fds: svc.openFds(),
    browserMB: browserMain() ? treeRssMb(browserMain().pid) : NaN, procs: svc.processes().length, tabs: ((await svc.targets()) || []).length,
    profileMB: dirSizeMB(`/tmp/prerender-lab-profile-${svc.servicePort}`), cacheEntries: await metric('prerender_cache_entries'), cacheKB: Math.round(await metric('prerender_cache_bytes') / 1024),
    inFlight: await metric('prerender_in_flight'), queued: await metric('prerender_queued'),
  });

  const problems = []; const counts = { requests: 0, ok: 0, errors5xx: 0, wrong: 0, hits: 0, coalesced: 0 };
  const render = async route => {
    const res = await svc.render(site.url(route), { timeout: 40000 }); counts.requests += 1;
    if (res.status === 200) counts.ok += 1; else if (res.status >= 500) counts.errors5xx += 1;
    if (res.headers && res.headers['x-prerender-cache'] === 'hit') counts.hits += 1;
    return res;
  };
  const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

  const start = Date.now(); const warm = [];
  let round = 0;
  await render('/simple'); await render('/spa'); await sleep(2000);
  const cold = await snapshot();
  const samples = [cold]; let nextSample = Date.now() + 60000; let baseline = cold;
  while (Date.now() - start < MINUTES * 60000) {
    round += 1;
    // 1. a burst of 16 callers for one new page: must be one render and 16 correct answers
    const before = site.hitsFor(`/spa?burst=${round}`).length;
    const burst = await parallel(16, () => render(`/spa?burst=${round}`));
    const wrong = burst.filter(r => r.status !== 200 || !/spa 50/.test(r.body || '')).length;
    counts.wrong += wrong; if (wrong) problems.push(`round ${round}: ${wrong} of 16 burst answers were wrong`);
    const asked = site.hitsFor(`/spa?burst=${round}`).length - before;
    if (asked !== 1) problems.push(`round ${round}: a burst of 16 asked the site ${asked} times`);
    // 2. mixed load, a few pages hostile or never finishing, with many different URLs so the cache keeps evicting
    const routes = ['/simple', '/spa', '/spa', '/simple', '/hang-ish', '/alert', '/popup', '/never'];
    await parallel(24, i => render(`${routes[(i + round) % routes.length]}?r=${round}&i=${i % 12}`));
    // 3. repeat requests for pages that should be cached
    await parallel(40, () => render('/simple'));
    if (Date.now() >= nextSample) { const s = await snapshot(); samples.push(s); nextSample += 60000; console.log(JSON.stringify(s)); if (samples.length === 2) baseline = s; } // the first minute is warm-up: the heap and the cache fill
    if (counts.requests > 0 && round % 20 === 0) console.log(`round ${round}: ${JSON.stringify(counts)}`);
  }
  await sleep(12000);
  const final = await snapshot(); samples.push(final);
  console.log('cold    ', JSON.stringify(cold)); console.log('baseline (after one minute of load)', JSON.stringify(baseline)); console.log('final   ', JSON.stringify(final)); counts.coalesced = await metric('prerender_coalesced_total');
  console.log('counts  ', JSON.stringify(counts), 'rounds', round);
  const half = samples.slice(Math.floor(samples.length / 2));
  const first = samples.slice(1, Math.max(2, Math.floor(samples.length / 2)));
  const avg = (list, key) => list.reduce((a, s) => a + s[key], 0) / list.length;
  const growth = key => Math.round(avg(half, key) - avg(first, key));
  console.log(`growth first half -> second half: node ${growth('nodeMB')} MB, heap ${growth('heapMB')} MB, browser ${growth('browserMB')} MB, fds ${growth('fds')}, procs ${growth('procs')}, profile ${growth('profileMB')} MB`);
  if (final.fds > baseline.fds + 30) problems.push(`descriptors grew from ${baseline.fds} to ${final.fds}`);
  if (final.procs > baseline.procs + 6) problems.push(`processes grew from ${baseline.procs} to ${final.procs}`);
  if (final.tabs > baseline.tabs + 2) problems.push(`tabs grew from ${baseline.tabs} to ${final.tabs}`);
  if (final.nodeMB > baseline.nodeMB * 1.25 + 20) problems.push(`service memory grew from ${baseline.nodeMB} to ${final.nodeMB} MB`);
  if (growth('nodeMB') > 25) problems.push(`service memory still growing: +${growth('nodeMB')} MB between the two halves`);
  if (final.inFlight !== 0 || final.queued !== 0) problems.push(`in flight ${final.inFlight}, queued ${final.queued} after the load stopped`);
  if (final.cacheEntries > 40) problems.push(`cache holds ${final.cacheEntries} entries, over its limit of 40`);
  const health = await request(`${svc.url}/healthz`); if (health.status !== 200) problems.push(`health ${health.status}`);
  console.log(problems.length ? `PROBLEMS:\n- ${problems.join('\n- ')}` : 'SOAK OK: no growth, no wrong answers');
  await svc.stop(); await site.stop();
  process.exit(problems.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
