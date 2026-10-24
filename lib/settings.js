'use strict';

// Tuning settings read from the environment. Every number has a default, a minimum and a maximum, and a value outside the
// range (or not a whole number) stops the container from starting with a plain message. A typo must never turn into "no limit".

const NUMBERS = {
  MAX_CONCURRENCY: { fallback: 4, min: 1, max: 64, about: 'pages rendered at the same time' },
  MAX_QUEUE: { fallback: 32, min: 0, max: 1024, about: 'requests allowed to wait for a free slot' },
  QUEUE_TIMEOUT_MS: { fallback: 10000, min: 100, max: 120000, about: 'longest a request waits for a free slot' },
  REQUEST_TIMEOUT_MS: { fallback: 30000, min: 1000, max: 300000, about: 'longest one request may take, start to finish' },
  PAGE_LOAD_TIMEOUT_MS: { fallback: 20000, min: 1000, max: 120000, about: 'longest the page may take to load' },
  WAIT_AFTER_LAST_REQUEST_MS: { fallback: 500, min: 0, max: 30000, about: 'quiet time after the last request before the page counts as done' },
  PAGE_DONE_CHECK_INTERVAL_MS: { fallback: 100, min: 20, max: 5000, about: 'how often a page is checked for being done (adds up to this much delay)' },
  MAX_RESPONSE_BYTES: { fallback: 10 * 1024 * 1024, min: 1024, max: 200 * 1024 * 1024, about: 'largest rendered page returned' },
  HEAP_SHED_PERCENT: { fallback: 85, min: 50, max: 99, about: 'percent of the Node heap limit above which new requests are turned away' },
  MAX_URL_LENGTH: { fallback: 2048, min: 64, max: 8192, about: 'longest request path accepted' },
  MAX_CONNECTIONS: { fallback: 512, min: 1, max: 10000, about: 'open client connections' },
  TAB_MAX_AGE_MS: { fallback: 40000, min: 5000, max: 600000, about: 'age at which a browser tab is closed by the watchdog' },
  BROWSER_MAX_RSS_MB: { fallback: 1536, min: 64, max: 65536, about: 'memory (PSS) used by the browser and its helpers before it is restarted' },
  BROWSER_RECYCLE_COOLDOWN_S: { fallback: 60, min: 1, max: 86400, about: 'shortest time between two memory restarts of the browser' },
  BROWSER_DOWN_EXIT_S: { fallback: 60, min: 5, max: 3600, about: 'seconds without a working browser before the container exits' },
  WATCHDOG_INTERVAL_MS: { fallback: 5000, min: 200, max: 60000, about: 'time between watchdog checks' },
  BROWSER_PROBE_FAILURES: { fallback: 3, min: 1, max: 20, about: 'failed liveness checks before a frozen browser is killed' },
  DRAIN_TIMEOUT_MS: { fallback: 15000, min: 0, max: 120000, about: 'time given to running requests on shutdown' },
  EGRESS_MAX_TUNNELS: { fallback: 256, min: 1, max: 10000, about: 'connections the page may hold open at once' },
  EGRESS_IDLE_TIMEOUT_MS: { fallback: 30000, min: 1000, max: 600000, about: 'idle time before a page connection is closed' },
  EGRESS_MAX_LIFETIME_MS: { fallback: 120000, min: 1000, max: 3600000, about: 'longest a single page connection may last' },
  EGRESS_DNS_TTL_MS: { fallback: 30000, min: 0, max: 600000, about: 'how long a resolved address is reused' },
};

function parseNumber(name, raw, spec) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return spec.fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name}: "${text.slice(0, 30)}" is not a whole number (${spec.about}).`);
  const value = Number(text);
  if (value < spec.min || value > spec.max) throw new Error(`${name}: ${value} is outside ${spec.min}..${spec.max} (${spec.about}).`);
  return value;
}

function parsePorts(raw) {
  const list = String(raw === undefined || String(raw).trim() === '' ? '80,443' : raw).split(',').map(part => part.trim()).filter(Boolean);
  const ports = [];
  for (const part of list) {
    if (!/^\d+$/.test(part) || Number(part) < 1 || Number(part) > 65535) throw new Error(`EGRESS_ALLOWED_PORTS: "${part.slice(0, 20)}" is not a port number.`);
    ports.push(Number(part));
  }
  if (ports.length === 0) throw new Error('EGRESS_ALLOWED_PORTS: list at least one port.');
  return ports;
}

function parseBoolean(value) {
  return String(value || '').toLowerCase() === 'true';
}

/** Settings from the environment. Throws a plain message for any value that is not valid. */
function loadSettings(env) {
  const settings = {};
  for (const [name, spec] of Object.entries(NUMBERS)) settings[name] = parseNumber(name, env[name], spec);
  if (settings.REQUEST_TIMEOUT_MS <= settings.PAGE_LOAD_TIMEOUT_MS) {
    throw new Error('REQUEST_TIMEOUT_MS must be larger than PAGE_LOAD_TIMEOUT_MS, or every slow page would be cut off before it can finish.');
  }
  if (settings.TAB_MAX_AGE_MS <= settings.REQUEST_TIMEOUT_MS) {
    throw new Error('TAB_MAX_AGE_MS must be larger than REQUEST_TIMEOUT_MS, or the watchdog would close tabs that are still in use.');
  }
  settings.EGRESS_ALLOWED_PORTS = parsePorts(env.EGRESS_ALLOWED_PORTS);
  settings.METRICS_ENABLED = parseBoolean(env.METRICS_ENABLED);
  settings.HOST = String(env.HOST || '0.0.0.0');
  return settings;
}

module.exports = { loadSettings, NUMBERS };
