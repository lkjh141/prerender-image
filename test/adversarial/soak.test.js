'use strict';

// Long-run behaviour. SOAK_REQUESTS (default 300) mixed renders, a few of them hostile, at a steady concurrency; then everything that
// could leak is measured against a baseline taken after a warm-up: process memory, open file descriptors, browser processes and tabs,
// disk used by the browser profile. BENCH=1 also prints latency and throughput figures (BENCH_OUT=file writes them as markdown).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Service, Site, sleep, percentile, dirSizeMB, skipReason, EXTERNAL } = require('../lab/lab');
const { treeRssMb } = require('../../lib/watchdog');

const skip = skipReason || (EXTERNAL ? 'needs the service process' : false);
const REQUESTS = Number(process.env.SOAK_REQUESTS || 300);
const ENV = { MAX_CONCURRENCY: '4', MAX_QUEUE: '64', PAGE_LOAD_TIMEOUT_MS: '3000', REQUEST_TIMEOUT_MS: '6000', TAB_MAX_AGE_MS: '9000', METRICS_ENABLED: 'true', QUEUE_TIMEOUT_MS: '30000', NODE_OPTIONS: '--max-old-space-size=384' };

let site; let svc;
test.before(async () => {
  if (skip) return;
  site = await new Site('127.0.0.1').start();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  site.route('/img.png', (req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); });
  site.route('/api', (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item ${i}` })) })); });
  site.html('/simple', '<!doctype html><title>simple</title><body><h1>Hello</h1><p>static</p>');
  site.html('/spa', `<!doctype html><title>spa</title><body><div id=app>loading</div><img src="/img.png"><script>
    fetch('/api').then(r=>r.json()).then(d=>{document.getElementById('app').innerHTML=d.items.map(i=>'<li>'+i.name+'</li>').join('')});
    document.title='spa loaded'</script>`);
  site.html('/heavy', `<!doctype html><title>heavy</title><body><div id=a></div><script>
    const a=document.getElementById('a');for(let i=0;i<3000;i++){const d=document.createElement('div');d.textContent='row '+i;a.appendChild(d)}</script>`);
  site.html('/hang-ish', '<!doctype html><title>x</title><body>x<script>setInterval(()=>fetch("/api"),10)</script>');
  site.html('/alert', '<!doctype html><title>x</title><body>x<script>alert(1);alert(2)</script>');
  site.html('/popup', '<!doctype html><title>x</title><body>x<script>window.open("/simple")</script>');
  svc = await new Service(ENV).start();
});
test.after(async () => { if (skip) return; await svc.stop(); await site.stop(); });

const mix = [['/simple', 25], ['/spa', 40], ['/heavy', 25], ['/hang-ish', 3], ['/alert', 3], ['/popup', 4]];
const pick = i => { let n = (i * 37) % 100; for (const [route, weight] of mix) { if (n < weight) return route; n -= weight; } return '/simple'; };
const browserMain = () => svc.processes().find(p => p.ppid === svc.pid && /chrom/i.test(p.args));
const metric = async name => { const m = await require('../lab/lab').request(`${svc.url}/metrics`); const x = new RegExp(`^${name} (\\d+)`, 'm').exec(m.body || ''); return x ? Number(x[1]) : NaN; };
const snapshot = async () => ({
  heapMB: await metric('prerender_node_heap_used_mb'), nodeMB: svc.nodeRssMB(), fds: svc.openFds(), browserMB: treeRssMb(browserMain().pid), browsers: svc.processes().filter(p => p.ppid === svc.pid && /chrom/i.test(p.args)).length,
  procs: svc.processes().length, tabs: ((await svc.targets()) || []).length, profileMB: dirSizeMB(`/tmp/prerender-lab-profile-${svc.servicePort}`),
});

async function load(total, concurrency, offset = 0, fixedRoute = null) {
  const results = []; let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const i = next++; if (i >= total) return;
      const route = fixedRoute || pick(i + offset);
      const res = await svc.render(site.url(route), { timeout: 40000 });
      results.push({ route, status: res.status, ms: res.ms, body: res.body, error: res.error });
    }
  }));
  return results;
}

test(`soak: ${REQUESTS} mixed renders leave no leak behind`, { skip, timeout: 900000 }, async () => {
  await load(40, 4); // warm-up: caches, JIT, thread pools
  await sleep(4000);
  const before = await snapshot();
  const t0 = Date.now();
  const results = await load(REQUESTS, 4, 1000);
  const seconds = (Date.now() - t0) / 1000;
  await sleep(12000); // let tab closing and the watchdog finish
  const after = await snapshot();

  const normal = results.filter(r => ['/simple', '/spa', '/heavy'].includes(r.route));
  const failed = normal.filter(r => r.status !== 200);
  const hostile = results.filter(r => !['/simple', '/spa', '/heavy'].includes(r.route));
  console.log(`# soak: ${results.length} renders in ${seconds.toFixed(1)} s (${(results.length / seconds).toFixed(1)}/s); normal pages failed: ${failed.length}/${normal.length}; hostile: ${hostile.length}`);
  console.log(`# before ${JSON.stringify(before)}\n# after  ${JSON.stringify(after)}`);

  assert.ok(failed.length / normal.length <= 0.01, `${failed.length} of ${normal.length} normal pages failed: ${JSON.stringify(failed.slice(0, 3).map(f => [f.route, f.status, f.error]))}`);
  assert.ok(normal.filter(r => r.route === '/spa').every(r => /item 49/.test(r.body || '')), 'script-built content was missing from a rendered page');
  assert.ok(hostile.every(r => r.status && r.status < 600), 'a hostile page got no answer');
  assert.ok(after.heapMB - before.heapMB < 100, `the service's JavaScript heap grew ${after.heapMB - before.heapMB} MB (${before.heapMB} -> ${after.heapMB})`);
  assert.ok(after.nodeMB - before.nodeMB < 120, `service memory grew ${Math.round(after.nodeMB - before.nodeMB)} MB`);
  assert.ok(after.fds - before.fds <= 20, `open file descriptors grew by ${after.fds - before.fds}`);
  assert.ok(after.browserMB - before.browserMB < 350, `browser memory grew ${Math.round(after.browserMB - before.browserMB)} MB`);
  assert.equal(after.browsers, 1, 'more than one browser process tree');
  assert.ok(after.procs <= before.procs + 4, `processes grew from ${before.procs} to ${after.procs}`);
  assert.ok(after.tabs <= Math.max(before.tabs, 1), `tabs left behind: ${after.tabs}`);
  assert.ok(after.profileMB - before.profileMB < 80, `browser profile on disk grew ${Math.round(after.profileMB - before.profileMB)} MB`);
});

test('benchmark: latency and throughput', { skip: skip || (process.env.BENCH ? false : 'set BENCH=1'), timeout: 900000 }, async () => {
  const rows = [];
  for (const route of ['/simple', '/spa', '/heavy']) {
    for (const concurrency of [1, 2, 4]) {
      const n = concurrency === 1 ? 40 : 80;
      const t0 = Date.now();
      const out = await load(n, concurrency, 0, route);
      const secs = (Date.now() - t0) / 1000;
      const ok = out.filter(o => o.status === 200).map(o => o.ms);
      rows.push({ route, concurrency, n, ok: ok.length, p50: percentile(ok, 50), p95: percentile(ok, 95), p99: percentile(ok, 99), rps: (ok.length / secs).toFixed(1) });
    }
  }
  const table = ['| page | concurrency | requests | ok | p50 ms | p95 ms | p99 ms | pages/s |', '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(r => `| ${r.route} | ${r.concurrency} | ${r.n} | ${r.ok} | ${r.p50} | ${r.p95} | ${r.p99} | ${r.rps} |`)].join('\n');
  console.log(`# benchmark\n${table.split('\n').map(l => `# ${l}`).join('\n')}`);
  if (process.env.BENCH_OUT) fs.writeFileSync(process.env.BENCH_OUT, `${table}\n`);
  assert.ok(rows.every(r => r.ok === r.n), 'some benchmark requests failed');
});
