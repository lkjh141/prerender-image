'use strict';

// A long soak that runs entirely inside one throw-away container of this image (nothing is published, nothing outside is contacted):
//
//   docker run --rm --name pt-soak --read-only --tmpfs /tmp:size=512m --cap-drop ALL --security-opt no-new-privileges:true \
//     --pids-limit 512 --memory 2g --cpus 2 -v /tmp/server-soak.js:/soak/server-soak.js:ro -e SOAK_MINUTES=60 \
//     --entrypoint node <image> /soak/server-soak.js
//
// It starts the service (server.js) and a small synthetic site on loopback, then repeats rounds of: a burst of callers for one new page,
// a mixed load (plain, script-driven, alert, pop-up, endless polling, never-finishing pages) with many different URLs so the cache keeps
// evicting, and repeat requests for cached pages. Once a minute it records memory, descriptors, threads, processes, the cache and the queue,
// reading /proc directly. At the end it compares the second half of the run with the first and exits 1 when something kept growing, a wrong
// answer came back, a burst rendered more than once, or the service did not recover. SOAK_DIR is where server.js is (default /app).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MINUTES = Number(process.env.SOAK_MINUTES || 60);
const DIR = process.env.SOAK_DIR || '/app';
const SERVICE_PORT = Number(process.env.SOAK_PORT || 3000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- the synthetic site
const hits = [];
const pages = {
  '/simple': '<!doctype html><title>simple</title><body><h1>Hello</h1><p>static</p>',
  '/spa': '<!doctype html><title>spa</title><body><div id=app>loading</div><script>fetch("/api").then(r=>r.json()).then(d=>{document.getElementById("app").textContent="spa "+d.items.length})</script>',
  '/hang-ish': '<!doctype html><title>x</title><body>x<script>setInterval(()=>fetch("/api"),10)</script>',
  '/alert': '<!doctype html><title>x</title><body>x<script>alert(1);alert(2)</script>',
  '/popup': '<!doctype html><title>x</title><body>x<script>window.open("/simple")</script>',
  '/never': '<!doctype html><title>x</title><body>x<script>fetch("/hole")</script>',
};
const site = http.createServer((req, res) => {
  hits.push(req.url);
  const route = req.url.split('?')[0];
  if (route === '/api') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => i) })); return; }
  if (route === '/hole') return; // never answered
  if (pages[route]) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(pages[route]); return; }
  res.writeHead(404); res.end('not found');
});

// ---- measuring through /proc
const readStatus = pid => { try { return fs.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch { return ''; } };
const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text); return m ? Number(m[1]) : 0; };
function tree(rootPid) { // the process and all its descendants
  const children = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(name));
    } catch { /* it exited */ }
  }
  const all = []; const queue = [rootPid];
  while (queue.length) { const pid = queue.shift(); all.push(pid); for (const child of children.get(pid) || []) queue.push(child); }
  return all;
}
const openFds = pid => { try { return fs.readdirSync(`/proc/${pid}/fd`).length; } catch { return NaN; } };

function get(urlPath, { timeout = 40000 } = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: SERVICE_PORT, path: urlPath, agent: false, timeout }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
      res.on('error', () => resolve({ status: 0, ms: Date.now() - started }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, ms: Date.now() - started }); });
    req.on('error', () => resolve({ status: 0, ms: Date.now() - started }));
  });
}

(async () => {
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const sitePort = site.address().port;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', CHROME_BIN: process.env.CHROME_BIN || '/usr/bin/chromium', NODE_ENV: 'production',
    PORT: String(SERVICE_PORT), ALLOWED_HOSTS: '127.0.0.1', METRICS_ENABLED: 'true', MAX_CONCURRENCY: '4', MAX_QUEUE: '64', QUEUE_TIMEOUT_MS: '30000',
    PAGE_LOAD_TIMEOUT_MS: '10000', REQUEST_TIMEOUT_MS: '14000', CACHE_TTL_S: '30', CACHE_MAX_ENTRIES: '40', CACHE_MAX_MB: '8',
    NODE_OPTIONS: process.env.SOAK_NODE_OPTIONS || '--max-old-space-size=384', CHROME_PROFILE_DIR: process.env.SOAK_PROFILE || '/tmp/soak-profile',
  };
  const child = spawn(process.execPath, [path.join(DIR, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: DIR });
  let log = ''; child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
  let exited = false; child.on('exit', code => { exited = true; console.log(`SERVICE EXITED with code ${code}`); });
  for (let i = 0; i < 60; i += 1) { const r = await get('/healthz', { timeout: 2000 }); if (r.status === 200) break; if (exited) { console.log(log); process.exit(2); } await sleep(500); }

  const metric = async name => { const r = await get('/metrics', { timeout: 5000 }); const m = new RegExp(`^${name} (\\d+)`, 'm').exec(r.body || ''); return m ? Number(m[1]) : NaN; };
  const snapshot = async () => {
    const pids = tree(child.pid); const rss = pid => kb(readStatus(pid), 'VmRSS') / 1024;
    const browserPids = pids.filter(pid => pid !== child.pid);
    return {
      min: Math.round((Date.now() - start) / 60000), serviceMB: Math.round(rss(child.pid)), browserMB: Math.round(browserPids.reduce((a, pid) => a + rss(pid), 0)),
      fds: openFds(child.pid), threads: kb(readStatus(child.pid), 'Threads'), procs: pids.length, heapMB: await metric('prerender_node_heap_used_mb'),
      cacheEntries: await metric('prerender_cache_entries'), inFlight: await metric('prerender_in_flight'), queued: await metric('prerender_queued'),
      tabs: await metric('prerender_browser_tabs'),
    };
  };

  const problems = []; const counts = { requests: 0, ok: 0, serverErrors: 0, noAnswer: 0, wrong: 0, hits: 0 };
  const render = async route => {
    const res = await get(`/http://127.0.0.1:${sitePort}${route}`); counts.requests += 1;
    if (res.status === 200) counts.ok += 1; else if (res.status >= 500) counts.serverErrors += 1; else if (res.status === 0) counts.noAnswer += 1;
    if (res.headers && res.headers['x-prerender-cache'] === 'hit') counts.hits += 1;
    return res;
  };
  const parallel = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
  const start = Date.now();
  await render('/simple'); await render('/spa'); await sleep(2000);
  const cold = await snapshot(); const samples = [cold]; let baseline = cold; let nextSample = Date.now() + 60000; let round = 0;
  console.log('cold', JSON.stringify(cold));
  while (Date.now() - start < MINUTES * 60000 && !exited) {
    round += 1;
    const before = hits.filter(url => url.startsWith(`/spa?burst=${round}`)).length;
    const burst = await parallel(16, () => render(`/spa?burst=${round}`));
    const wrong = burst.filter(r => r.status !== 200 || !/spa 50/.test(r.body || '')).length;
    counts.wrong += wrong; if (wrong) problems.push(`round ${round}: ${wrong} of 16 burst answers were wrong`);
    const asked = hits.filter(url => url.startsWith(`/spa?burst=${round}`)).length - before;
    if (asked !== 1) problems.push(`round ${round}: a burst of 16 asked the site ${asked} times`);
    const routes = ['/simple', '/spa', '/spa', '/simple', '/hang-ish', '/alert', '/popup', '/never'];
    await parallel(24, i => render(`${routes[(i + round) % routes.length]}?r=${round}&i=${i % 12}`));
    await parallel(40, () => render('/simple'));
    if (Date.now() >= nextSample) {
      const s = await snapshot(); samples.push(s); nextSample += 60000; console.log(JSON.stringify(s));
      if (samples.length === 2) baseline = s; // the first minute is warm-up: the heap and the cache fill
    }
  }
  await sleep(12000);
  const final = await snapshot(); samples.push(final);
  counts.coalesced = await metric('prerender_coalesced_total'); counts.timeouts = await metric('prerender_timeouts_total'); counts.queueFull = await metric('prerender_queue_full_total');
  console.log('cold    ', JSON.stringify(cold)); console.log('baseline', JSON.stringify(baseline)); console.log('final   ', JSON.stringify(final));
  console.log('counts  ', JSON.stringify(counts), 'rounds', round, 'minutes', Math.round((Date.now() - start) / 60000));
  const half = samples.slice(Math.floor(samples.length / 2)); const first = samples.slice(1, Math.max(2, Math.floor(samples.length / 2)));
  const avg = (list, key) => list.reduce((a, s) => a + s[key], 0) / list.length;
  const growth = key => Math.round(avg(half, key) - avg(first, key));
  console.log(`growth first half -> second half: service ${growth('serviceMB')} MB, heap ${growth('heapMB')} MB, browser ${growth('browserMB')} MB, fds ${growth('fds')}, threads ${growth('threads')}, procs ${growth('procs')}`);
  if (exited) problems.push('the service exited during the soak');
  if (counts.noAnswer > 0) problems.push(`${counts.noAnswer} requests got no answer`);
  if (final.fds > baseline.fds + 30) problems.push(`descriptors grew from ${baseline.fds} to ${final.fds}`);
  if (final.procs > baseline.procs + 6) problems.push(`processes grew from ${baseline.procs} to ${final.procs}`);
  if (final.tabs > baseline.tabs + 2) problems.push(`tabs grew from ${baseline.tabs} to ${final.tabs}`);
  if (final.serviceMB > baseline.serviceMB * 1.25 + 20) problems.push(`service memory grew from ${baseline.serviceMB} to ${final.serviceMB} MB`);
  if (growth('serviceMB') > 25) problems.push(`service memory still growing: +${growth('serviceMB')} MB between the two halves`);
  if (growth('browserMB') > 150) problems.push(`browser memory still growing: +${growth('browserMB')} MB between the two halves`);
  if (final.inFlight !== 0 || final.queued !== 0) problems.push(`in flight ${final.inFlight}, queued ${final.queued} after the load stopped`);
  if (final.cacheEntries > 40) problems.push(`cache holds ${final.cacheEntries} entries, over its limit of 40`);
  const health = await get('/healthz', { timeout: 5000 }); if (health.status !== 200) problems.push(`health ${health.status}`);
  console.log(problems.length ? `PROBLEMS:\n- ${problems.slice(0, 20).join('\n- ')}` : 'SOAK OK: no growth, no wrong answers, every burst cost one render');
  child.kill('SIGTERM'); await sleep(1500); site.close();
  process.exit(problems.length ? 1 : 0);
})().catch(error => { console.error(error); process.exit(2); });
