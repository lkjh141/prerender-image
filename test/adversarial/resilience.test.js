'use strict';

// Failure of the parts around the service: the browser dies, freezes or grows, the process is told to stop while busy.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { Service, Site, request, sleep, skipReason, EXTERNAL } = require('../lab/lab');

const skip = skipReason || (EXTERNAL ? 'needs the service process' : false);
const ENV = { MAX_CONCURRENCY: '3', MAX_QUEUE: '6', PAGE_LOAD_TIMEOUT_MS: '3000', REQUEST_TIMEOUT_MS: '6000', TAB_MAX_AGE_MS: '9000', WATCHDOG_INTERVAL_MS: '500', BROWSER_PROBE_FAILURES: '3', DRAIN_TIMEOUT_MS: '10000', METRICS_ENABLED: 'true' };
let site;
test.before(async () => {
  if (skip) return;
  site = await new Site('127.0.0.1').start();
  site.html('/ok', '<!doctype html><title>ok</title><body><div id=o></div><script>document.getElementById("o").textContent="rendered fine"</script>');
  site.route('/slow', (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>s</title><body>slow done'); }, 1500); });
});
test.after(async () => { if (!skip) await site.stop(); });

const health = svc => request(`${svc.url}/healthz`, { timeout: 3000 });
async function until(fn, ms = 30000, step = 200) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); } }
/** The browser's main process: the Chromium process whose parent is the service. */
const browserPid = svc => { const p = svc.processes().find(x => x.ppid === svc.pid && /chrom/i.test(x.args)); return p && p.pid; };
async function works(svc, label) {
  const res = await svc.render(site.url('/ok'), { timeout: 40000 });
  assert.equal(res.status, 200, `${label}: ${res.status} ${res.error || ''}`);
  assert.match(res.body, /rendered fine/);
}

test('the browser is killed outright: the service notices, starts a new one and renders again', { skip, timeout: 120000 }, async () => {
  const svc = await new Service(ENV).start();
  try {
    await works(svc, 'before');
    const pid = browserPid(svc);
    assert.ok(pid, 'found the browser process');
    process.kill(pid, 'SIGKILL');
    assert.ok(await until(async () => (await health(svc)).status === 503, 10000), 'it should report not ready while the browser is gone');
    assert.ok(await until(async () => (await health(svc)).status === 200, 40000), 'it never came back');
    await works(svc, 'after recovery');
    assert.ok(svc.alive());
    await sleep(1500);
    const mains = svc.processes().filter(x => x.ppid === svc.pid && /chrom/i.test(x.args));
    assert.equal(mains.length, 1, 'exactly one browser, no orphan from before');
  } finally { await svc.stop(); }
});

test('a browser that is frozen (not dead) is detected and replaced', { skip, timeout: 120000 }, async () => {
  const svc = await new Service(ENV).start();
  try {
    await works(svc, 'before');
    const pid = browserPid(svc);
    process.kill(pid, 'SIGSTOP');
    const t0 = Date.now();
    const recovered = await until(async () => { const p = browserPid(svc); return p && p !== pid && (await health(svc)).status === 200; }, 60000, 300);
    assert.ok(recovered, 'the frozen browser was never replaced');
    console.log(`# frozen browser replaced after ${Date.now() - t0} ms`);
    await works(svc, 'after replacement');
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  } finally { await svc.stop(); }
});

test('the browser dies while pages are rendering: those fail cleanly, the next ones succeed', { skip, timeout: 120000 }, async () => {
  const svc = await new Service(ENV).start();
  try {
    const running = Array.from({ length: 3 }, (_, i) => svc.render(site.url(`/slow?i=${i}`), { timeout: 40000 }));
    await sleep(500);
    process.kill(browserPid(svc), 'SIGKILL');
    const results = await Promise.all(running);
    for (const r of results) assert.ok(r.status && r.status >= 200 && r.status < 600 && !/at .*\(|node_modules/.test(r.body || ''), `bad answer: ${r.status} ${r.error}`);
    assert.ok(await until(async () => (await health(svc)).status === 200, 40000));
    // A request that races the restart may still fail once (the browser reports ready a moment before a fresh page can be opened).
    // The guarantee is that rendering works again within seconds, not that no request ever falls into the gap.
    const recovered = await until(async () => (await svc.render(site.url('/ok'), { timeout: 15000 })).status === 200, 30000, 500);
    assert.ok(recovered, 'rendering did not work again after the browser was killed under load');
  } finally { await svc.stop(); }
});

test('a browser that grows past its memory limit is recycled', { skip, timeout: 120000 }, async () => {
  const svc = await new Service({ ...ENV, BROWSER_MAX_RSS_MB: '64', BROWSER_RECYCLE_COOLDOWN_S: '3' }).start();
  try {
    const first = browserPid(svc);
    assert.ok(first, 'found the first browser');
    const replaced = await until(async () => { const p = browserPid(svc); return p && p !== first && (await health(svc)).status === 200; }, 60000, 300);
    assert.ok(replaced, 'the browser was never recycled although it exceeds 64 MB');
    const m = await request(`${svc.url}/metrics`);
    assert.match(m.body, /prerender_browser_memory_restarts_total [1-9]/);
    await works(svc, 'after recycling');
  } finally { await svc.stop(); }
});

test('SIGTERM while busy: running pages finish, new ones are refused, exit code 0, nothing left behind', { skip, timeout: 120000 }, async () => {
  const svc = await new Service(ENV).start();
  const running = Array.from({ length: 3 }, (_, i) => svc.render(site.url(`/slow?i=${i}`), { timeout: 40000 }));
  await sleep(600);
  const t0 = Date.now();
  svc.child.kill('SIGTERM');
  await sleep(200);
  const during = await health(svc);
  const late = await svc.render(site.url('/ok'), { timeout: 10000 });
  const results = await Promise.all(running);
  const exit = await Promise.race([svc.exited, sleep(30000).then(() => 'timeout')]);
  assert.ok([503, undefined].includes(during.status), `health during drain: ${during.status}`);
  assert.ok(late.status === 503 || late.error, `a new request during drain got ${late.status}`);
  assert.deepEqual(results.map(r => r.status), [200, 200, 200], 'pages that were running were finished');
  assert.deepEqual(exit, { code: 0, signal: null }, `exit: ${JSON.stringify(exit)}`);
  assert.ok(Date.now() - t0 < 15000, `stopping took ${Date.now() - t0} ms`);
  await sleep(1000);
  const leftovers = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n').filter(l => l.includes(`prerender-lab-profile-${svc.servicePort}`));
  assert.equal(leftovers.length, 0, `browser processes left behind:\n${leftovers.join('\n')}`);
  await svc.stop();
});

test('SIGTERM when idle exits at once', { skip, timeout: 60000 }, async () => {
  const svc = await new Service(ENV).start();
  const t0 = Date.now();
  svc.child.kill('SIGTERM');
  const exit = await Promise.race([svc.exited, sleep(15000).then(() => 'timeout')]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.ok(Date.now() - t0 < 4000, `idle stop took ${Date.now() - t0} ms`);
  await svc.stop();
});
