'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createWatchdog, treeRssMb } = require('../lib/watchdog');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('memory of the browser and all its children is added up, and unrelated processes are not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proc-'));
  const proc = (pid, ppid, kb) => { fs.mkdirSync(path.join(dir, String(pid))); fs.writeFileSync(path.join(dir, String(pid), 'status'), `Name:\tx\nPPid:\t${ppid}\nVmRSS:\t${kb} kB\n`); };
  proc(100, 1, 102400); proc(101, 100, 204800); proc(102, 101, 102400); proc(200, 1, 999999); proc(103, 100, 0);
  fs.writeFileSync(path.join(dir, 'self'), 'not a pid');
  assert.equal(treeRssMb(100, dir), 400);
  assert.equal(treeRssMb(999, dir), 0);
  assert.equal(treeRssMb(100, '/nonexistent'), 0);
});

async function fakeBrowser(targets) {
  const closed = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/json/list') { res.end(JSON.stringify(targets())); return; }
    const m = /^\/json\/close\/(.+)$/.exec(req.url);
    if (m) { closed.push(decodeURIComponent(m[1])); res.end('Target is closing'); return; }
    res.statusCode = 404; res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, closed, stop: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

test('tabs older than the limit are closed; the start-up tab and young tabs are not', async () => {
  let list = [{ id: 'boot', type: 'page' }];
  const b = await fakeBrowser(() => list);
  const wd = createWatchdog({ server: { browser: {}, isBrowserConnected: true }, debugPort: b.port, settings: { TAB_MAX_AGE_MS: 150, BROWSER_MAX_RSS_MB: 1e9, BROWSER_DOWN_EXIT_S: 60 }, exit: () => assert.fail('must not exit') });
  try {
    await wd.tick();
    list = [{ id: 'boot', type: 'page' }, { id: 'a', type: 'page' }, { id: 'sw', type: 'service_worker' }];
    await wd.tick();
    await sleep(250);
    list = [...list, { id: 'young', type: 'page' }];
    await wd.tick();
    await sleep(50);
    assert.deepEqual(b.closed, ['a'], 'only the old page was closed');
    assert.equal(wd.stats.tabsClosed, 1);
  } finally { await b.stop(); }
});

test('the browser is restarted when it uses too much memory: when idle above the limit, at once above twice the limit', async () => {
  const b = await fakeBrowser(() => []);
  let restarts = 0;
  const server = { browser: { chromeChild: { pid: process.pid } }, isBrowserConnected: true, browserRequestsInFlight: new Map([['r', 'u']]), restartBrowser: () => { restarts += 1; } };
  const own = treeRssMb(process.pid);
  assert.ok(own > 20, `this process uses ${own} MB`);
  try {
    const mk = limit => createWatchdog({ server, debugPort: b.port, settings: { TAB_MAX_AGE_MS: 1e6, BROWSER_MAX_RSS_MB: limit, BROWSER_DOWN_EXIT_S: 60 }, exit: () => {} });
    await mk(Math.floor(own * 0.75)).tick(); // above the limit but busy, and not above twice the limit
    assert.equal(restarts, 0, 'a busy browser is left alone below twice the limit');
    server.browserRequestsInFlight = new Map();
    await mk(Math.floor(own * 0.75)).tick();
    assert.equal(restarts, 1, 'an idle browser above the limit is restarted');
    server.browserRequestsInFlight = new Map([['r', 'u']]);
    await mk(Math.floor(own / 3)).tick();
    assert.equal(restarts, 2, 'above twice the limit restarts even a busy browser');
    await mk(own * 10).tick();
    assert.equal(restarts, 2, 'a browser under the limit is left alone');
  } finally { await b.stop(); }
});

test('the process exits when no browser comes back, not before', async () => {
  const b = await fakeBrowser(() => []);
  let exited = null;
  const server = { browser: {}, isBrowserConnected: false, isBrowserClosing: false };
  const wd = createWatchdog({ server, debugPort: b.port, settings: { TAB_MAX_AGE_MS: 1e6, BROWSER_MAX_RSS_MB: 1e9, BROWSER_DOWN_EXIT_S: 0.2 }, exit: code => { exited = code; } });
  try {
    await wd.tick();
    assert.equal(exited, null, 'not at the first sign');
    await sleep(300);
    server.isBrowserConnected = true;
    await wd.tick();
    assert.equal(exited, null, 'a recovered browser resets the clock');
    server.isBrowserConnected = false;
    await wd.tick();
    await sleep(300);
    await wd.tick();
    assert.equal(exited, 1);
  } finally { await b.stop(); }
});
