'use strict';

const prerender = require('prerender');
const { loadConfig, createGuardPlugin } = require('./lib/guard');

let config;
try {
  config = loadConfig(process.env);
} catch (error) {
  console.error(`prerender-image: ${error.message}`);
  process.exit(1);
}

const debuggingPort = Number.parseInt(process.env.BROWSER_DEBUGGING_PORT || '', 10) || 9222;

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
  '--mute-audio',
  '--user-data-dir=/tmp/chromium-profile',
  `--remote-debugging-port=${debuggingPort}`,
];

const server = prerender({
  chromeLocation: process.env.CHROME_BIN || '/usr/bin/chromium',
  chromeFlags,
  browserDebuggingPort: debuggingPort,
  logRequests: process.env.LOG_REQUESTS === 'true',
});

const log = message => console.log(`${new Date().toISOString()} ${message}`);

// The guard goes first, so a request that is not allowed never reaches the browser.
server.use(createGuardPlugin(config, log));
// The same default plugins the community image enables: pages can set their status code and headers with meta tags
// (prerender-status-code, prerender-header), and script tags are removed from the result.
server.use(prerender.httpHeaders());
server.use(prerender.removeScriptTags());

function stop() {
  server.killBrowser();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

log(config.allowAnyHost ? 'Rendering any host (ALLOW_ANY_HOST=true)' : `Rendering only: ${config.allowedHosts.join(', ')}`);
server.start();
