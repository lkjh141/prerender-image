'use strict';

const net = require('node:net');
const v8 = require('node:v8');
const prerender = require('prerender');
const prerenderUtil = require('prerender/lib/util');
const { loadConfig, createGuardPlugin } = require('./lib/guard');
const { loadSettings } = require('./lib/settings');
const { createEgressProxy } = require('./lib/egress');
const { createFront } = require('./lib/front');
const { createWatchdog } = require('./lib/watchdog');
const { createReleasePlugin } = require('./lib/release');

const log = message => console.log(`${new Date().toISOString()} ${message}`);

let config;
let settings;
try {
  config = loadConfig(process.env);
  settings = loadSettings(process.env);
} catch (error) {
  console.error(`prerender-image: ${error.message}`);
  process.exit(1);
}

// An exception nobody caught leaves the process in an unknown state: exit, and the orchestrator restarts the container.
process.on('uncaughtException', error => { console.error(`uncaught exception: ${error && error.message}`); process.exit(1); });

// A rejected promise nobody handled is different. Prerender asks the browser to close a JavaScript dialog one second after it
// opens, without a catch; if the page or tab is already gone the browser answers "No dialog is showing", and Node's default
// would then end the whole process. One page with alert() in a loop could take the service down that way. Log it and count it.
const quiet = { unhandledRejections: 0 };
process.on('unhandledRejection', reason => {
  quiet.unhandledRejections += 1;
  if (quiet.unhandledRejections <= 20 || quiet.unhandledRejections % 100 === 0) {
    console.error(`unhandled rejection ignored (${quiet.unhandledRejections} so far): ${reason && reason.message ? reason.message : reason}`);
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function main() {
  const publicPort = Number.parseInt(process.env.PORT || '', 10) || 3000;
  const debugPort = Number.parseInt(process.env.BROWSER_DEBUGGING_PORT || '', 10) || 9222;
  const internalPort = await freePort();

  // Everything the browser opens goes through this proxy, which is where private networks are kept out (lib/egress.js).
  const reservedPorts = new Set([publicPort, debugPort, internalPort]);
  const egress = createEgressProxy({ config, settings, reservedPorts, log });
  const egressPort = await egress.listen();
  reservedPorts.add(egressPort);

  // Flags for running Chromium as an unprivileged user inside a container. --no-sandbox is needed because containers usually
  // do not allow the user namespaces Chromium's own sandbox uses; the container itself is the boundary (see the README).
  const chromeFlags = [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-notifications',
    '--disable-domain-reliability',
    '--disable-features=Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
    '--no-pings',
    '--noerrdialogs',
    '--deny-permission-prompts',
    '--block-new-web-contents',
    '--mute-audio',
    '--metrics-recording-only',
    // Network: one proxy for everything, no local name resolution, no WebRTC traffic that could skip the proxy.
    `--proxy-server=http://127.0.0.1:${egressPort}`,
    '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    // Memory: a small disk cache in the temporary directory and a cap on each page's JavaScript heap.
    '--disk-cache-size=33554432',
    '--media-cache-size=1',
    `--js-flags=--max-old-space-size=${process.env.CHROME_JS_HEAP_MB || 512}`,
    `--user-data-dir=${process.env.CHROME_PROFILE_DIR || '/tmp/chromium-profile'}`,
    `--remote-debugging-port=${debugPort}`,
  ];

  const server = prerender({
    chromeLocation: process.env.CHROME_BIN || '/usr/bin/chromium',
    chromeFlags,
    browserDebuggingPort: debugPort,
    // Prerender listens on a loopback port only. The public listener is the front server below.
    host: '127.0.0.1',
    port: internalPort,
    logRequests: process.env.LOG_REQUESTS === 'true',
    pageLoadTimeout: settings.PAGE_LOAD_TIMEOUT_MS,
    waitAfterLastRequest: settings.WAIT_AFTER_LAST_REQUEST_MS || 1,
    pageDoneCheckInterval: settings.PAGE_DONE_CHECK_INTERVAL_MS,
  });

  // The guard goes first, so a request that is not allowed never reaches the browser.
  server.use(createGuardPlugin(config, log));
  // The same default plugins the community image enables: pages can set their status code and headers with meta tags
  // (prerender-status-code, prerender-header), and script tags are removed from the result (JSON-LD is kept).
  // Script removal goes FIRST. With any status other than 200 the headers plugin ends the plugin chain, and a plugin registered after
  // it never runs: in the stock order, every 404 page kept its application scripts.
  server.use(prerender.removeScriptTags());
  server.use(prerender.httpHeaders());
  // Last, so it runs after everything that reads the finished request: it hands the request's memory back (lib/release.js).
  server.use(createReleasePlugin());

  const front = createFront({
    config,
    settings,
    upstreamPort: internalPort,
    logRequests: process.env.LOG_REQUESTS === 'true',
    isBrowserConnected: () => Boolean(server.isBrowserConnected),
    inFlightInBrowser: () => (server.browserRequestsInFlight ? server.browserRequestsInFlight.size : 0),
    underMemoryPressure: () => process.memoryUsage().heapUsed / v8.getHeapStatistics().heap_size_limit * 100 > settings.HEAP_SHED_PERCENT,
    getUtil: () => prerenderUtil,
    log,
    extraMetrics: () => [
      (() => { const m = process.memoryUsage(); const mb = v => Math.round(v / 1048576); return `# TYPE prerender_node_rss_mb gauge\nprerender_node_rss_mb ${mb(m.rss)}\n# TYPE prerender_node_heap_used_mb gauge\nprerender_node_heap_used_mb ${mb(m.heapUsed)}\n# TYPE prerender_node_external_mb gauge\nprerender_node_external_mb ${mb(m.external + m.arrayBuffers)}\n`; })(),
      `# TYPE prerender_egress_allowed_total counter\nprerender_egress_allowed_total ${egress.stats.allowed}\n`,
      `# TYPE prerender_egress_blocked_total counter\nprerender_egress_blocked_total ${egress.stats.blocked}\n`,
      `# TYPE prerender_egress_open_connections gauge\nprerender_egress_open_connections ${egress.stats.openTunnels}\n`,
      `# TYPE prerender_unhandled_rejections_total counter\nprerender_unhandled_rejections_total ${quiet.unhandledRejections}\n`,
      `# TYPE prerender_watchdog_tabs_closed_total counter\nprerender_watchdog_tabs_closed_total ${watchdog.stats.tabsClosed}\n`,
      `# TYPE prerender_browser_memory_restarts_total counter\nprerender_browser_memory_restarts_total ${watchdog.stats.restartsForMemory}\n`,
      `# TYPE prerender_browser_frozen_kills_total counter\nprerender_browser_frozen_kills_total ${watchdog.stats.killedFrozen}\n`,
      `# TYPE prerender_browser_memory_mb gauge\nprerender_browser_memory_mb ${watchdog.stats.lastRssMb}\n`,
    ].join(''),
  });
  const watchdog = createWatchdog({ server, debugPort, settings, log });

  const publicServer = front.createServer();
  await new Promise((resolve, reject) => {
    publicServer.once('error', reject);
    publicServer.listen(publicPort, settings.HOST, resolve);
  });
  log(`Listening on ${settings.HOST}:${publicPort}`);

  let stopping = false;
  async function stop(signal) {
    if (stopping) return;
    stopping = true;
    log(`${signal}: draining (up to ${settings.DRAIN_TIMEOUT_MS} ms)`);
    publicServer.close();
    const clean = await front.drain(settings.DRAIN_TIMEOUT_MS);
    log(clean ? 'drained' : 'drain timed out; closing the remaining requests');
    watchdog.stop();
    server.killBrowser();
    setTimeout(() => process.exit(clean ? 0 : 1), 500).unref();
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  log(config.allowAnyHost ? 'Rendering any public host (ALLOW_ANY_HOST=true)' : `Rendering only: ${config.allowedHosts.join(', ')}`);
  watchdog.start();
  server.start();
}

main().catch(error => { console.error(`prerender-image: ${error.message}`); process.exit(1); });
