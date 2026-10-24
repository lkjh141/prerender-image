'use strict';

const fs = require('node:fs');
const http = require('node:http');

// Things Prerender does not do on its own, checked every few seconds:
//
//   - Tabs that outlive their request (a page that hangs, a pop-up, a crashed renderer) are closed after TAB_MAX_AGE_MS.
//   - The browser's total memory is read from /proc. Above BROWSER_MAX_RSS_MB it is restarted when idle, and above twice that
//     at once, so a leak or a hostile page cannot grow the container until the kernel kills it.
//   - If no browser has been connected for BROWSER_DOWN_EXIT_S seconds the process exits, so the orchestrator restarts the
//     container instead of leaving a running container that answers nothing.

function getJson(port, path, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/** Resident memory of a process and all its children, in MB. Linux only; returns 0 where /proc is missing. */
function treeRssMb(rootPid, procDir = '/proc') {
  let names;
  try { names = fs.readdirSync(procDir).filter(name => /^\d+$/.test(name)); } catch { return 0; }
  const parent = new Map();
  const rss = new Map();
  for (const pid of names) {
    try {
      const status = fs.readFileSync(`${procDir}/${pid}/status`, 'utf8');
      const ppid = /^PPid:\s+(\d+)/m.exec(status);
      const mem = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
      parent.set(Number(pid), ppid ? Number(ppid[1]) : 0);
      rss.set(Number(pid), mem ? Number(mem[1]) : 0);
    } catch { /* the process ended while we looked */ }
  }
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) if (!inTree.has(pid) && inTree.has(ppid)) { inTree.add(pid); grew = true; }
  }
  let total = 0;
  for (const pid of inTree) total += rss.get(pid) || 0;
  return Math.round(total / 1024);
}

function createWatchdog({ server, debugPort, settings, log = () => {}, exit = code => process.exit(code), intervalMs = 5000 }) {
  const firstSeen = new Map();
  const protectedIds = new Set();
  const stats = { tabsClosed: 0, restartsForMemory: 0, lastRssMb: 0, ticks: 0 };
  let downSince = null;
  let timer = null;
  let booted = false;

  async function closeStaleTabs() {
    let targets;
    try { targets = await getJson(debugPort, '/json/list'); } catch { return; }
    if (!Array.isArray(targets)) return;
    const now = Date.now();
    const pages = targets.filter(target => target.type === 'page');
    if (!booted) { for (const page of pages) protectedIds.add(page.id); booted = true; }
    const live = new Set(pages.map(page => page.id));
    for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id);
    for (const page of pages) {
      if (protectedIds.has(page.id)) continue;
      if (!firstSeen.has(page.id)) firstSeen.set(page.id, now);
      if (now - firstSeen.get(page.id) > settings.TAB_MAX_AGE_MS) {
        stats.tabsClosed += 1;
        log(`closing a tab that outlived its request (${Math.round((now - firstSeen.get(page.id)) / 1000)}s)`);
        getJson(debugPort, `/json/close/${encodeURIComponent(page.id)}`).catch(() => {});
        firstSeen.delete(page.id);
      }
    }
  }

  function checkMemory() {
    const child = server.browser && server.browser.chromeChild;
    if (!child || !child.pid) return;
    const used = treeRssMb(child.pid);
    stats.lastRssMb = used;
    const limit = settings.BROWSER_MAX_RSS_MB;
    const busy = server.browserRequestsInFlight ? server.browserRequestsInFlight.size > 0 : false;
    if (used > limit * 2 || (used > limit && !busy)) {
      stats.restartsForMemory += 1;
      log(`browser memory is ${used} MB (limit ${limit} MB): restarting the browser`);
      server.restartBrowser();
    }
  }

  function checkBrowser() {
    if (server.isBrowserConnected || server.isBrowserClosing) { downSince = null; return; }
    if (downSince === null) downSince = Date.now();
    if (Date.now() - downSince > settings.BROWSER_DOWN_EXIT_S * 1000) {
      log(`no browser for ${settings.BROWSER_DOWN_EXIT_S}s: exiting so the container is restarted`);
      exit(1);
    }
  }

  async function tick() {
    stats.ticks += 1;
    try { await closeStaleTabs(); checkMemory(); checkBrowser(); } catch (error) { log(`watchdog error: ${error.message}`); }
  }

  return {
    stats,
    tick,
    start() { timer = setInterval(tick, intervalMs); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createWatchdog, treeRssMb };
