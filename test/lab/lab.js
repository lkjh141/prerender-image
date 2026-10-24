'use strict';

// A small laboratory for attacking and stressing the service: it starts the real server.js with a real Chromium, runs hostile "websites"
// and "internal services" on separate loopback addresses, and measures processes, memory and open browser tabs.
//
// By default every test file starts its own service (needs a Chromium: set CHROME_BIN). Set SERVICE_URL to test a service that is already
// running, for example the container in CI; then the checks that need the service's process or its debugging port are skipped.

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CHROME = process.env.CHROME_BIN || '/usr/bin/chromium';
const EXTERNAL = process.env.SERVICE_URL || '';
const haveChrome = fs.existsSync(CHROME);
const skipReason = EXTERNAL || haveChrome ? false : `no Chromium at ${CHROME} (set CHROME_BIN)`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function listen(server, host = '127.0.0.1', port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

function randomPort() { return 20000 + Math.floor(Math.random() * 30000); }

/** One request to the service (or any URL). Never throws: errors come back as { error }. */
function request(target, { method = 'GET', headers = {}, body = null, timeout = 90000, raw = false } = {}) {
  const started = Date.now();
  return new Promise(resolve => {
    let url;
    try { url = typeof target === 'string' ? new URL(target) : target; } catch (error) { resolve({ error: String(error), ms: 0 }); return; }
    const options = { method, headers, host: url.hostname, port: url.port, path: raw ? target.path : url.pathname + url.search, timeout };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const buffer = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, body: buffer.toString('utf8'), buffer, ms: Date.now() - started }); });
      res.on('error', error => resolve({ error: String(error), ms: Date.now() - started }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', error => resolve({ error: String(error.code || error.message), ms: Date.now() - started }));
    if (body) req.write(body);
    req.end();
  });
}

/** A raw TCP conversation, for requests Node's http client would refuse to send. Resolves with whatever came back. */
function rawExchange(port, text, { host = '127.0.0.1', timeout = 8000, close = true } = {}) {
  return new Promise(resolve => {
    const socket = net.connect(port, host);
    const chunks = [];
    const done = () => { socket.destroy(); resolve(Buffer.concat(chunks).toString('latin1')); };
    socket.setTimeout(timeout, done);
    socket.on('data', c => { chunks.push(c); if (close && /\r\n\r\n/.test(Buffer.concat(chunks).toString('latin1'))) setTimeout(done, 150); });
    socket.on('error', done);
    socket.on('close', done);
    socket.write(text);
  });
}

/** Processes below a pid: [{ pid, ppid, rssKB, args }] (Linux). */
function descendants(rootPid) {
  let rows;
  try { rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; }
  const all = rows.map(line => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), rssKB: Number(m[3]), args: m[4] } : null;
  }).filter(Boolean);
  const found = [];
  const queue = [rootPid];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of all) if (p.ppid === parent) { found.push(p); queue.push(p.pid); }
  }
  return found;
}

function dirSizeMB(dir) {
  try { return Number(execFileSync('du', ['-sk', dir], { encoding: 'utf8' }).split('\t')[0]) / 1024; } catch { return 0; }
}

/** The service under test. */
class Service {
  constructor(env = {}) {
    this.servicePort = randomPort();
    this.debugPort = this.servicePort + 1;
    this.env = env;
    this.log = '';
    this.child = null;
    this.external = Boolean(EXTERNAL);
  }

  get url() { return EXTERNAL || `http://127.0.0.1:${this.servicePort}`; }
  get port() { return Number(new URL(this.url).port); }

  async start() {
    if (this.external) return this;
    this.child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, CHROME_BIN: CHROME,
        CHROME_PROFILE_DIR: `/tmp/prerender-lab-profile-${this.servicePort}`, PORT: String(this.servicePort), BROWSER_DEBUGGING_PORT: String(this.debugPort), ALLOWED_HOSTS: '127.0.0.1',
        ...this.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', d => { this.log += d; });
    this.child.stderr.on('data', d => { this.log += d; });
    this.exited = new Promise(resolve => this.child.on('exit', (code, signal) => resolve({ code, signal })));
    const end = Date.now() + 60000;
    for (;;) {
      if ((await request(`${this.url}/healthz`, { timeout: 3000 })).status === 200) break;
      if (Date.now() > end) throw new Error(`the service did not start:\n${this.log}`);
      await sleep(250);
    }
    return this;
  }

  get pid() { return this.child ? this.child.pid : null; }
  processes() { return this.pid ? descendants(this.pid) : []; }
  chromeProcesses() { return this.processes().filter(p => /chrom/i.test(p.args)); }
  rssMB() { return this.processes().reduce((n, p) => n + p.rssKB, 0) / 1024; }
  nodeRssMB() {
    if (!this.pid) return 0;
    try { return Number(fs.readFileSync(`/proc/${this.pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]) / 1024; } catch { return 0; }
  }
  openFds() { try { return fs.readdirSync(`/proc/${this.pid}/fd`).length; } catch { return 0; } }

  /** Open page targets in the browser, through its debugging port (not available for an external service). */
  async targets() {
    if (this.external) return null;
    const res = await request(`http://127.0.0.1:${this.debugPort}/json/list`, { timeout: 5000 });
    if (!res.body) return null;
    try { return JSON.parse(res.body).filter(t => t.type === 'page'); } catch { return null; }
  }

  /** Render a page. `target` is a full URL. */
  render(target, { ua = 'Googlebot/2.1', headers = {}, timeout } = {}) {
    return request(`${this.url}/${target}`, { headers: { 'user-agent': ua, ...headers }, timeout });
  }

  alive() { return this.external ? true : this.child.exitCode === null && this.child.signalCode === null; }

  async stop() {
    if (this.external || !this.child) return;
    if (this.alive()) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, sleep(8000)]);
      if (this.alive()) this.child.kill('SIGKILL');
    }
    // Anything left behind is a leak; kill it so the next test starts clean.
    for (const p of descendants(process.pid).filter(p => /chrom/i.test(p.args) && /prerender-lab-profile|chromium-profile/.test(p.args))) {
      try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}

/** A website the service is allowed to render. Routes are plain functions; every request is recorded. */
class Site {
  constructor(host = '127.0.0.1') { this.host = host; this.routes = new Map(); this.hits = []; this.server = null; }
  route(pathname, handler) { this.routes.set(pathname, handler); return this; }
  html(pathname, markup, status = 200, headers = {}) {
    return this.route(pathname, (req, res) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(markup); });
  }
  async start(port = 0) {
    this.server = http.createServer((req, res) => {
      this.hits.push(req.url);
      const handler = this.routes.get(req.url.split('?')[0]);
      if (typeof handler === 'function') { handler(req, res); return; }
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
    });
    this.server.keepAliveTimeout = 1000;
    this.port = await listen(this.server, this.host, port);
    return this;
  }
  get origin() { return `http://${this.host}:${this.port}`; }
  url(pathname = '/') { return `${this.origin}${pathname}`; }
  hitsFor(prefix) { return this.hits.filter(u => u.startsWith(prefix)); }
  async stop() { if (this.server) { this.server.closeAllConnections?.(); await new Promise(r => this.server.close(r)); } }
}

/** A "private service" that must never be contacted: HTTP, raw TCP (WebSocket) and UDP (WebRTC), all recorded. */
class Secret {
  constructor(host = '127.0.0.2') { this.host = host; this.http = []; this.tcp = []; this.udp = []; }
  async start() {
    this.server = http.createServer((req, res) => { this.http.push(`${req.method} ${req.url}`); res.writeHead(200, { 'access-control-allow-origin': '*' }); res.end('SECRET'); });
    this.server.on('upgrade', (req, socket) => { this.tcp.push(`upgrade ${req.url}`); socket.destroy(); });
    this.port = await listen(this.server, this.host);
    this.raw = net.createServer(socket => { this.tcp.push('raw connection'); socket.destroy(); });
    this.rawPort = await listen(this.raw, this.host);
    this.dgram = dgram.createSocket('udp4');
    await new Promise(r => this.dgram.bind(0, this.host, r));
    this.udpPort = this.dgram.address().port;
    this.dgram.on('message', (msg, rinfo) => this.udp.push(`${msg.length} bytes from ${rinfo.address}`));
    return this;
  }
  get origin() { return `http://${this.host}:${this.port}`; }
  get contacted() { return this.http.length + this.tcp.length + this.udp.length; }
  describe() { return JSON.stringify({ http: this.http, tcp: this.tcp, udp: this.udp }); }
  async stop() {
    this.server.closeAllConnections?.();
    await Promise.all([new Promise(r => this.server.close(r)), new Promise(r => this.raw.close(r)), new Promise(r => this.dgram.close(r))]);
  }
}

/** A self-signed certificate for HTTPS tests. */
function selfSigned(dir, host = '127.0.0.1') {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=IP:${host}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

module.exports = { Service, Site, Secret, request, rawExchange, listen, sleep, descendants, dirSizeMB, selfSigned, percentile, skipReason, CHROME, EXTERNAL, crypto };
