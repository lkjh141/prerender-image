'use strict';

const fs = require('node:fs');
const http = require('node:http');

// Things Prerender does not do on its own, checked every few seconds:
//
//   - Tabs that outlive their request (a page that hangs, a pop-up, a crashed renderer) are closed after TAB_MAX_AGE_MS.
//   - The browser's total memory is read from /proc. Above BROWSER_MAX_RSS_MB it is restarted when idle, and above twice that
//     at once, so a leak or a hostile page cannot grow the container until the kernel kills it.
//   - The browser is asked for its version through the debugging port. Prerender only notices a browser that closes its connection,
//     not one that is frozen (a stopped process, a deadlock). After BROWSER_PROBE_FAILURES missed answers in a row it is killed,
//     and Prerender starts a new one.
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

/**
 * Memory of a process and all its children, in MB. Linux only; returns 0 where /proc is missing.
 * Chromium runs many processes that share most of their pages, so adding up resident sizes (RSS) counts the same memory several
 * times (a fresh, idle browser reads as ~900 MB that way). The proportional size (PSS) splits shared pages between the processes
 * that use them and adds up to the real total. PSS is read where the system allows it and RSS is the fallback.
 */
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
    } catch { /* the process ended while the scan was reading it, which is normal and not an error */ }
  }
  const inTree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) if (!inTree.has(pid) && inTree.has(ppid)) { inTree.add(pid); grew = true; }
  }
  let total = 0;
  for (const pid of inTree) {
    let kb = rss.get(pid) || 0;
    // The expensive file is read only for the few processes that belong to the browser.
    try {
      const pss = /^Pss:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`${procDir}/${pid}/smaps_rollup`, 'utf8'));
      if (pss) kb = Number(pss[1]);
    } catch { /* not readable: keep the resident size */ }
    total += kb;
  }
  return Math.round(total / 1024);
}

// Prerender treats a browser that dies less than a second after it started as a crash loop and ends the whole process. A browser
// is therefore never recycled for memory before it has been seen running for this long, whatever the limit is.
const MIN_BROWSER_AGE_MS = 2000;

function createWatchdog({ server, debugPort, settings, log = () => {}, exit = code => process.exit(code), intervalMs = settings.WATCHDOG_INTERVAL_MS || 5000, minBrowserAgeMs = MIN_BROWSER_AGE_MS }) {
  const firstSeen = new Map();
  const protectedIds = new Set();
  const stats = { tabsClosed: 0, restartsForMemory: 0, killedFrozen: 0, lastRssMb: 0, ticks: 0 };
  let downSince = null;
  let missedProbes = 0;
  let lastRecycle = 0;
  let seenPid = null; // the browser process last seen, and when it was first seen: a new process is a new browser
  let seenAt = 0;
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
    if (!child || !child.pid || !server.isBrowserConnected) return; // never touch a browser that is still starting
    const used = treeRssMb(child.pid);
    stats.lastRssMb = used;
    if (child.pid !== seenPid) { seenPid = child.pid; seenAt = Date.now(); }
    if (Date.now() - seenAt < minBrowserAgeMs) return; // too young to be touched
    const limit = settings.BROWSER_MAX_RSS_MB;
    const busy = server.browserRequestsInFlight ? server.browserRequestsInFlight.size > 0 : false;
    const cooledDown = Date.now() - lastRecycle > settings.BROWSER_RECYCLE_COOLDOWN_S * 1000;
    if (cooledDown && (used > limit * 2 || (used > limit && !busy))) {
      lastRecycle = Date.now();
      stats.restartsForMemory += 1;
      log(`browser memory is ${used} MB (limit ${limit} MB): restarting the browser`);
      server.restartBrowser();
    }
  }

  async function probeBrowser() {
    if (!server.isBrowserConnected) { missedProbes = 0; return; }
    try {
      await getJson(debugPort, '/json/version', Math.min(2000, intervalMs));
      missedProbes = 0;
    } catch {
      missedProbes += 1;
      if (missedProbes >= settings.BROWSER_PROBE_FAILURES) {
        missedProbes = 0;
        const child = server.browser && server.browser.chromeChild;
        stats.killedFrozen += 1;
        log('the browser stopped answering: killing it so a new one starts');
        if (child && child.pid) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      }
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
    try { await probeBrowser(); await closeStaleTabs(); checkMemory(); checkBrowser(); } catch (error) { log(`watchdog error: ${error.message}`); }
  }

  return {
    stats,
    tick,
    start() { timer = setInterval(tick, intervalMs); timer.unref(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}

module.exports = { createWatchdog, treeRssMb, MIN_BROWSER_AGE_MS };
