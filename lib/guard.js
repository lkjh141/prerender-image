'use strict';

const net = require('node:net');

// Two protections around the Prerender service, which otherwise fetches whatever URL it is asked for:
//
//   1. A host allowlist for the page that is rendered (ALLOWED_HOSTS). A request for any other host is refused with 403.
//      This keeps the service from being used to read internal addresses (server-side request forgery) or as an open renderer.
//   2. A filter for everything the page itself loads while it is rendered: private, loopback and link-local addresses, local
//      names and non-web schemes are refused, so a page cannot be used to reach the network the container sits on. Hosts you
//      list in ALLOWED_HOSTS are always allowed, so rendering a development page on localhost works when you ask for it.
//
// DNS names that resolve to private addresses are not caught here (the browser resolves them). Keep the container on a network
// that cannot reach anything private, for example with an egress firewall. See the README.

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);
const INLINE_SCHEMES = new Set(['data:', 'blob:', 'about:']);
const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp'];
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// What the optional resource blocking (BLOCK_RESOURCES=true) refuses: trackers, ad networks, fonts and images. The text of
// the page does not depend on them, and skipping them makes rendering faster.
const BLOCKED_RESOURCES = [
  'google-analytics.com', 'googletagmanager.com', 'api.mixpanel.com', 'fonts.googleapis.com', 'stats.g.doubleclick.net',
  'googleads.g.doubleclick.net', 'pagead2.googlesyndication.com', 'tpc.googlesyndication.com', 'partner.googleadservices.com',
  'mc.yandex.ru', 'use.typekit.net', 'fast.fonts.com', 'api.segment.io', 'cdn.heapanalytics.com', 'js-agent.newrelic.com',
  'woopra.com', 'static.olark.com', 'static.getclicky.com', 'fullstory.com/rec', 'hn.inspectlet.com', 'youtube.com/embed',
  '.ttf', '.eot', '.otf', '.woff', '.woff2', '.png', '.gif', '.tiff', '.jpg', '.jpeg', '.ico', '.svg', '.webp', '.avif', '.pdf',
];

/** Lower-case host name without brackets or a trailing dot, as the WHATWG URL parser spells it. */
function normalizeHost(host) {
  return String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/**
 * Reads ALLOWED_HOSTS: host names separated by commas. Exact names only, no wildcards, no ports, no schemes.
 * Throws on anything else, so a typo stops the container from starting instead of silently allowing too much or too little.
 */
function parseAllowedHosts(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return [];
  const hosts = [];
  for (const part of String(raw).split(',')) {
    const host = normalizeHost(part.trim());
    if (!host) continue;
    if (!(HOST_PATTERN.test(host) || net.isIP(host))) {
      throw new Error(`ALLOWED_HOSTS: "${part.trim().slice(0, 60)}" is not a plain host name (no wildcards, ports or schemes).`);
    }
    if (!hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function ipv4Parts(address) {
  return address.split('.').map(Number);
}

function isPrivateIPv4(address) {
  const [a, b, c] = ipv4Parts(address);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIPv6(address) {
  const lower = address.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or its hex form) and the deprecated IPv4-compatible forms carry an IPv4 address.
  const dotted = /^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = /^(?:::ffff:|::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return isPrivateIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(lower.split(':')[0] || '0', 16);
  return (first & 0xfe00) === 0xfc00 // fc00::/7 unique local
    || (first & 0xffc0) === 0xfe80 // fe80::/10 link local
    || (first & 0xff00) === 0xff00; // ff00::/8 multicast
}

/** True when this IP address (either family, any spelling the resolver returns) is not a public one. */
function isPrivateAddress(address) {
  const name = normalizeHost(String(address).replace(/%.*$/, ''));
  const family = net.isIP(name);
  if (family === 4) return isPrivateIPv4(name);
  if (family === 6) return isPrivateIPv6(name);
  return true; // not an address at all: refuse
}

/** True for loopback, private, link-local and similar addresses, and for names that only mean something on a local network. */
function isPrivateHost(host) {
  const name = normalizeHost(host);
  if (!name) return true;
  const family = net.isIP(name);
  if (family === 4) return isPrivateIPv4(name);
  if (family === 6) return isPrivateIPv6(name);
  if (name === 'localhost' || !name.includes('.')) return true; // a bare name resolves through the local resolver
  return LOCAL_SUFFIXES.some(suffix => name.endsWith(suffix)) || name === 'metadata.google.internal';
}

function parseWebUrl(raw) {
  let url;
  try { url = new URL(String(raw)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null; // "https://allowed.example@evil.example/" must never pass for allowed.example
  if (!url.hostname) return null;
  return url;
}

/** Is this page one the service may render? */
function isAllowedTarget(raw, config) {
  const url = parseWebUrl(raw);
  if (!url) return false;
  const host = normalizeHost(url.hostname);
  if (config.allowedHosts.includes(host)) return true;
  // ALLOW_ANY_HOST means any public host. Private and local addresses stay refused unless ALLOW_PRIVATE_TARGETS=true.
  return Boolean(config.allowAnyHost) && (!isPrivateHost(host) || Boolean(config.allowPrivate));
}

/** Why a request made by the page being rendered must be refused, or null when it may go ahead. */
function subrequestBlockReason(raw, config) {
  let url;
  try { url = new URL(String(raw)); } catch { return 'invalid-url'; }
  if (INLINE_SCHEMES.has(url.protocol)) return null;
  if (!WEB_SCHEMES.has(url.protocol)) return 'scheme';
  const host = normalizeHost(url.hostname);
  if (!config.allowedHosts.includes(host) && !config.allowPrivate && isPrivateHost(host)) return 'private-address';
  if (config.blockResources) {
    const text = url.href.toLowerCase();
    if (BLOCKED_RESOURCES.some(part => text.includes(part))) return 'resource';
  }
  return null;
}

function parseBoolean(value) {
  return String(value || '').toLowerCase() === 'true';
}

/** Settings from the environment. Throws a plain message when the container is not set up safely. */
function loadConfig(env) {
  const allowedHosts = parseAllowedHosts(env.ALLOWED_HOSTS);
  const allowAnyHost = parseBoolean(env.ALLOW_ANY_HOST);
  if (allowedHosts.length === 0 && !allowAnyHost) {
    throw new Error('Set ALLOWED_HOSTS to the host names this service may render (for example example.com,www.example.com). '
      + 'To render any host, which is only safe on a network nothing else can reach, set ALLOW_ANY_HOST=true.');
  }
  return { allowedHosts, allowAnyHost, allowPrivate: parseBoolean(env.ALLOW_PRIVATE_TARGETS), allowInvalidCerts: parseBoolean(env.ALLOW_INVALID_CERTS), blockResources: parseBoolean(env.BLOCK_RESOURCES) };
}

/** The Prerender plugin that applies both protections. */
function createGuardPlugin(config, log = () => {}, { pageFilter = true, diagnostics = false } = {}) {
  return {
    requestReceived: (req, res, next) => {
      if (!isAllowedTarget(req.prerender.url, config)) {
        log(`refused a request for a host that is not allowed: ${String(req.prerender.url).slice(0, 120)}`);
        res.send(403);
        return;
      }
      next();
    },
    tabCreated: (req, res, next) => {
      const { Fetch } = req.prerender.tab;
      // Requests the browser has paused and not yet released. With DIAGNOSTICS=true, one that stays paused is reported by name.
      const pending = new Map();
      const release = (requestId, action) => result => {
        const entry = pending.get(requestId);
        pending.delete(requestId);
        if (entry) clearTimeout(entry.timer);
        return result;
      };
      const fail = (requestId, what) => error => {
        if (diagnostics) log(`DIAG ${what} failed for a paused request: ${String(error && error.message).slice(0, 80)}`);
        pending.delete(requestId);
      };
      if (pageFilter) {
        Fetch.requestPaused(({ requestId, request }) => {
          if (diagnostics) {
            const timer = setTimeout(() => log(`DIAG a request has been paused for 3 s and not released: ${String(request.url).slice(0, 140)}`), 3000);
            timer.unref();
            pending.set(requestId, { timer });
          }
          const reason = subrequestBlockReason(request.url, config);
          if (reason) {
            if (reason !== 'resource') log(`blocked a request made by the page (${reason}): ${String(request.url).slice(0, 120)}`);
            Fetch.failRequest({ requestId, errorReason: 'BlockedByClient' }).then(release(requestId)).catch(fail(requestId, 'failRequest'));
          } else {
            Fetch.continueRequest({ requestId }).then(release(requestId)).catch(fail(requestId, 'continueRequest'));
          }
        });
      }
      // Prerender switches certificate checking off for every tab (it accepts any certificate). Switch it back on, so a page
      // behind an expired, self-signed or wrong-host certificate is not rendered. ALLOW_INVALID_CERTS=true restores the old behaviour.
      const { Security } = req.prerender.tab;
      if (!config.allowInvalidCerts && Security && typeof Security.setOverrideCertificateErrors === 'function') {
        Security.setOverrideCertificateErrors({ override: false }).catch(() => {});
      }
      // A page must not be able to stall the tab with alert(), or save files into the container.
      const { Page } = req.prerender.tab;
      if (Page && typeof Page.javascriptDialogOpening === 'function') {
        Page.javascriptDialogOpening(() => { Page.handleJavaScriptDialog({ accept: false }).catch(() => {}); });
      }
      if (Page && typeof Page.setDownloadBehavior === 'function') Page.setDownloadBehavior({ behavior: 'deny' }).catch(() => {});
      if (!pageFilter) { next(); return; }
      Fetch.enable({ patterns: [{ urlPattern: '*' }] }).then(() => next()).catch(() => next());
    },
  };
}

module.exports = {
  parseAllowedHosts, isPrivateHost, isPrivateAddress, isAllowedTarget, subrequestBlockReason, loadConfig, createGuardPlugin, normalizeHost, BLOCKED_RESOURCES,
};
