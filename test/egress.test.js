'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { createEgressProxy } = require('../lib/egress');
const { loadSettings } = require('../lib/settings');

const settings = loadSettings({ EGRESS_DNS_TTL_MS: '0' });
const names = {
  'public.example': ['93.184.216.34'],
  'rebind.example': ['93.184.216.34', '10.0.0.5'],
  'internal.example': ['192.168.1.10'],
  'mapped.example': ['::ffff:10.0.0.1'],
  'ipv6-public.example': ['2606:2800:220:1:248:1893:25c8:1946'],
  'dev.example': ['127.0.0.1'],
};
const lookup = async host => {
  if (!names[host]) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; }
  return names[host].map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
};
const proxy = (config = {}, reserved = [3000, 9222]) => createEgressProxy({
  config: { allowedHosts: ['public.example'], allowPrivate: false, ...config }, settings, reservedPorts: new Set(reserved), lookup,
});

test('public names are allowed and connect to the resolved address (pinned)', async () => {
  const p = proxy();
  assert.deepEqual(await p.decide('public.example', 443), { ok: true, address: '93.184.216.34' });
  assert.equal((await p.decide('ipv6-public.example', 443)).ok, true);
});

test('any private address in the answer refuses the connection (DNS rebinding sets, mapped IPv6, loopback names)', async () => {
  const p = proxy({ allowedHosts: [] });
  for (const host of ['rebind.example', 'internal.example', 'mapped.example', 'dev.example', '127.0.0.1', '10.0.0.1', '169.254.169.254', '[::1]', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0']) {
    const verdict = await p.decide(host, 443);
    assert.equal(verdict.ok, false, host);
    assert.match(verdict.reason, /private-address|dns/, host);
  }
});

test('numeric spellings of private addresses are refused after the resolver has had its say', async () => {
  const p = createEgressProxy({
    config: { allowedHosts: [], allowPrivate: false }, settings, reservedPorts: new Set(),
    lookup: async host => [{ address: { '2130706433': '127.0.0.1', '0x7f.1': '127.0.0.1', '017700000001': '127.0.0.1' }[host] || '8.8.8.8', family: 4 }],
  });
  for (const host of ['2130706433', '0x7f.1', '017700000001']) assert.equal((await p.decide(host, 443)).ok, false, host);
});

test('only the listed ports are open unless the host itself is listed', async () => {
  const p = proxy();
  assert.equal((await p.decide('rebind.example', 22)).reason, 'port');
  assert.equal((await proxy({ allowedHosts: [] }).decide('public.example', 6379)).reason, 'port');
  assert.equal((await p.decide('public.example', 8080)).ok, true, 'a listed host may use any port');
  assert.equal((await p.decide('public.example', 0)).reason, 'bad-target');
  assert.equal((await p.decide('public.example', 65536)).reason, 'bad-target');
  assert.equal((await p.decide('', 443)).reason, 'bad-target');
});

test('a listed host may be private, but the service\'s own ports are never reachable', async () => {
  const p = proxy({ allowedHosts: ['dev.example', '127.0.0.1'] });
  assert.equal((await p.decide('dev.example', 8080)).ok, true, 'a development host the operator listed');
  assert.equal((await p.decide('127.0.0.1', 8080)).ok, true);
  for (const port of [3000, 9222]) {
    assert.equal((await p.decide('127.0.0.1', port)).reason, 'service-port', `port ${port}`);
    assert.equal((await p.decide('dev.example', port)).reason, 'service-port', `port ${port} by name`);
  }
});

test('ALLOW_PRIVATE_TARGETS opens private addresses on purpose', async () => {
  assert.equal((await proxy({ allowedHosts: [], allowPrivate: true }).decide('internal.example', 443)).ok, true);
});

test('an unknown name is refused', async () => {
  assert.equal((await proxy().decide('nx.example', 443)).reason, 'dns');
});

async function listen(server) { await new Promise(r => server.listen(0, '127.0.0.1', r)); return server.address().port; }

test('CONNECT: a refused target gets 403 and an allowed one is tunnelled byte for byte', async () => {
  const echo = net.createServer(socket => socket.on('data', d => socket.write(Buffer.concat([Buffer.from('echo:'), d]))));
  const echoPort = await listen(echo);
  const p = createEgressProxy({ config: { allowedHosts: ['127.0.0.1'], allowPrivate: false }, settings, reservedPorts: new Set([9222]), lookup });
  const port = await p.listen();
  try {
    const connect = target => new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
      let data = '';
      socket.on('data', d => {
        data += d;
        if (data.includes('\r\n\r\n') && /200/.test(data) && !data.includes('echo:')) socket.write('hello');
        if (data.includes('echo:hello') || /^HTTP\/1.1 (4|5)\d\d/.test(data)) { socket.destroy(); resolve(data); }
      });
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); resolve(data); }, 3000);
    });
    assert.match(await connect(`127.0.0.1:${echoPort}`), /echo:hello/, 'the tunnel carried the bytes');
    assert.match(await connect('127.0.0.1:9222'), /^HTTP\/1\.1 403/, 'the debugging port is refused');
    assert.match(await connect('10.0.0.1:443'), /^HTTP\/1\.1 403/, 'a private address is refused');
    assert.match(await connect('not a target'), /^HTTP\/1\.1 400/);
    assert.ok(p.stats.blocked >= 2);
  } finally { await p.close(); echo.close(); }
});

test('plain http through the proxy is checked the same way', async () => {
  const origin = http.createServer((req, res) => { res.setHeader('x-seen-host', req.headers.host); res.end('origin-body'); });
  const originPort = await listen(origin);
  const p = createEgressProxy({ config: { allowedHosts: ['127.0.0.1'], allowPrivate: false }, settings, reservedPorts: new Set(), lookup });
  const port = await p.listen();
  const get = target => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: target, headers: { host: new URL(target).host } }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
  try {
    const ok = await get(`http://127.0.0.1:${originPort}/x`);
    assert.equal(ok.status, 200);
    assert.equal(ok.body, 'origin-body');
    assert.equal((await get('http://169.254.169.254/latest/meta-data/')).status, 403);
    assert.equal((await get('http://nx.example/')).status, 403);
  } finally { await p.close(); origin.close(); }
});

test('the number of open tunnels is capped', async () => {
  const hold = net.createServer(() => {});
  const holdPort = await listen(hold);
  const small = loadSettings({ EGRESS_MAX_TUNNELS: '2', EGRESS_DNS_TTL_MS: '0' });
  const p = createEgressProxy({ config: { allowedHosts: ['127.0.0.1'], allowPrivate: false }, settings: small, reservedPorts: new Set(), lookup });
  const port = await p.listen();
  const opened = [];
  try {
    const statuses = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(await new Promise(resolve => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(`CONNECT 127.0.0.1:${holdPort} HTTP/1.1\r\nHost: x\r\n\r\n`));
        opened.push(socket);
        let data = '';
        socket.on('data', d => { data += d; resolve(/^HTTP\/1\.1 (\d{3})/.exec(data)[1]); });
        socket.on('error', () => resolve('error'));
      }));
    }
    assert.deepEqual(statuses.slice(0, 2), ['200', '200']);
    assert.ok(statuses.slice(2).every(s => s === '503'), `later tunnels were refused: ${statuses}`);
  } finally { opened.forEach(s => s.destroy()); await p.close(); hold.close(); }
});
