'use strict';

// Hostile and malformed requests to the service itself. None may crash it, hang it, leak internals, or make it render something it should not.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { Service, Site, request, rawExchange, sleep, skipReason } = require('../lab/lab');

let service; let site;
test.before(async () => {
  if (skipReason) return;
  site = await new Site('127.0.0.1').start();
  site.html('/ok', '<!doctype html><html><head><title>ok</title></head><body><div id="r">fine</div></body></html>');
  service = await new Service().start();
});
test.after(async () => { if (skipReason) return; await service.stop(); await site.stop(); });

const LEAK = /node_modules|\/app\/|at (?:Object|Function|Module|process|async)\b|TypeError|ReferenceError|RangeError|stack|\.js:\d+/;

async function stillWorks(label) {
  assert.ok(service.alive(), `${label}: the service died\n${service.log.slice(-1500)}`);
  const res = await service.render(site.url('/ok'), { timeout: 60000 });
  assert.equal(res.status, 200, `${label}: a normal request no longer works (${res.status} ${res.error || ''})`);
  assert.match(res.body, /fine/);
}

function noLeak(res, label) {
  if (res && res.body) assert.doesNotMatch(res.body.slice(0, 2000), LEAK, `${label}: the response shows internals: ${res.body.slice(0, 300)}`);
}

test('unusual HTTP methods are handled', { skip: skipReason, timeout: 120000 }, async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD']) {
    const res = await request(`${service.url}/${site.url('/ok')}`, { method, headers: { 'user-agent': 'Googlebot' }, timeout: 60000 });
    assert.ok(res.status || res.error, `${method} produced no answer`);
    noLeak(res, method);
  }
  const trace = await rawExchange(service.port, `TRACE /${site.url('/ok')} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
  assert.ok(!/HTTP\/1\.1 200/.test(trace) || !/TRACE \//.test(trace.split('\r\n\r\n')[1] || ''), 'TRACE echoes the request back');
  await stillWorks('methods');
});

test('/render with strange parameters does not crash the service', { skip: skipReason, timeout: 180000 }, async () => {
  const u = encodeURIComponent(site.url('/ok'));
  const cases = [
    '/render', '/render?url=', `/render?url=${u}&url=${u}`, `/render?url[]=${u}`, `/render?url[a]=${u}`, `/render?url[__proto__][x]=1`,
    `/render?url=${u}&renderType=png&width=999999&height=999999&fullpage=true`, `/render?url=${u}&renderType=pdf`, `/render?url=${u}&renderType=har`,
    `/render?url=${u}&renderType=nonsense`, `/render?url=${u}&javascript=document.body.innerHTML='x'`, `/render?url=${u}&userAgent=${'A'.repeat(5000)}`,
    `/render?url=${'a'.repeat(100000)}`, `/render?${'a=1&'.repeat(5000)}url=${u}`, '/render?url=%', '/render?url=%ZZ', `/render?url=${u}&followRedirects=true`,
  ];
  for (const path of cases) {
    const res = await request(`${service.url}${path}`, { headers: { 'user-agent': 'Googlebot' }, timeout: 60000 });
    assert.ok(res.status || res.error, `${path.slice(0, 60)} produced no answer`);
    noLeak(res, path.slice(0, 60));
    assert.ok(service.alive(), `${path.slice(0, 60)} killed the service\n${service.log.slice(-1500)}`);
  }
  await stillWorks('/render parameters');
});

test('POST /render with hostile bodies does not crash the service', { skip: skipReason, timeout: 180000 }, async () => {
  const json = { 'content-type': 'application/json', 'user-agent': 'Googlebot' };
  const bodies = [
    '{"url":123}', '{"url":null}', '{"url":["a","b"]}', '{"url":{"a":1}}', '{"url":true}', '{"__proto__":{"url":"x"}}', '{"constructor":{"prototype":{"polluted":1}}}',
    '{not json', '', 'null', '[]', '"string"', JSON.stringify({ url: site.url('/ok'), renderType: { toString: 1 } }), JSON.stringify({ url: site.url('/ok'), width: 'x'.repeat(100000) }),
    JSON.stringify({ url: site.url('/ok'), javascript: 'while(true){}' }),
  ];
  for (const body of bodies) {
    const res = await request(`${service.url}/render`, { method: 'POST', headers: json, body, timeout: 60000 });
    assert.ok(res.status || res.error, `POST ${body.slice(0, 40)} produced no answer`);
    noLeak(res, `POST ${body.slice(0, 40)}`);
    assert.ok(service.alive(), `POST ${body.slice(0, 40)} killed the service\n${service.log.slice(-1500)}`);
  }
  const big = await request(`${service.url}/render`, { method: 'POST', headers: json, body: JSON.stringify({ url: site.url('/ok'), pad: 'x'.repeat(6 * 1024 * 1024) }), timeout: 60000 });
  assert.ok([413, 400, 403, 405].includes(big.status) || big.error, `a 6 MB body was accepted: ${big.status}`);
  await stillWorks('POST bodies');
});

test('malformed paths and raw protocol abuse do not crash the service', { skip: skipReason, timeout: 180000 }, async () => {
  const exchanges = [
    `GET /%00 HTTP/1.1\r\nHost: a\r\n\r\n`, `GET /%c0%af HTTP/1.1\r\nHost: a\r\n\r\n`, `GET /http:/127.0.0.1/ HTTP/1.1\r\nHost: a\r\n\r\n`, `GET /http:///x HTTP/1.1\r\nHost: a\r\n\r\n`,
    `GET // HTTP/1.1\r\nHost: a\r\n\r\n`, `GET http://127.0.0.1/ HTTP/1.1\r\nHost: a\r\n\r\n`, `GET / HTTP/1.0\r\n\r\n`, `GET /${'a'.repeat(100000)} HTTP/1.1\r\nHost: a\r\n\r\n`,
    `GET /x HTTP/1.1\r\nHost: a\r\nX-Big: ${'b'.repeat(40000)}\r\n\r\n`, `GET /x HTTP/1.1\r\nHost: a\r\n${Array.from({ length: 3000 }, (_, i) => `X-${i}: 1`).join('\r\n')}\r\n\r\n`,
    `POST /render HTTP/1.1\r\nHost: a\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\nGET /smuggled HTTP/1.1\r\n\r\n`,
    `GET /x HTTP/1.1\r\nHost: a\r\nContent-Length: -1\r\n\r\n`, `GET /x HTTP/1.1\r\nHost: a\r\nExpect: 100-continue\r\n\r\n`, `\x00\x01\x02garbage\r\n\r\n`, `GET /\r\n\r\n`,
    `GET /${site.url('/ok')}\r\nX: y\r\n\r\n`, `GET /x HTTP/1.1\r\nHost: a\r\nHost: b\r\n\r\n`, `GET /x\u0000y HTTP/1.1\r\nHost: a\r\n\r\n`,
  ];
  for (const text of exchanges) {
    const out = await rawExchange(service.port, text, { timeout: 6000 });
    noLeak({ body: out.split('\r\n\r\n').slice(1).join('\r\n\r\n') }, JSON.stringify(text.slice(0, 40)));
    assert.ok(service.alive(), `${JSON.stringify(text.slice(0, 50))} killed the service\n${service.log.slice(-1500)}`);
  }
  await stillWorks('raw protocol');
});

test('idle and half-open connections do not exhaust the service (slowloris)', { skip: skipReason, timeout: 180000 }, async () => {
  const sockets = [];
  const fdsBefore = service.openFds();
  for (let i = 0; i < 1500; i += 1) {
    const s = net.connect(service.port, '127.0.0.1');
    s.on('error', () => {});
    s.write(i % 2 ? 'GET /x HTTP/1.1\r\nHost: a\r\nX-Slow: ' : '');
    sockets.push(s);
  }
  await sleep(1500);
  const during = await service.render(site.url('/ok'), { timeout: 60000 });
  assert.equal(during.status, 200, 'a normal request fails while 1500 connections sit open');
  const fdsDuring = service.openFds();
  for (const s of sockets) s.destroy();
  await sleep(2000);
  assert.ok(service.alive());
  if (fdsBefore) assert.ok(service.openFds() < fdsBefore + 50, `file descriptors leaked: ${fdsBefore} before, ${service.openFds()} after (peak ${fdsDuring})`);
  await stillWorks('slowloris');
});

test('requests the caller abandons do not leave browser tabs behind', { skip: skipReason || (process.env.SERVICE_URL && 'needs the debugging port'), timeout: 180000 }, async () => {
  site.route('/slowpage', (req, res) => { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><body>late</body></html>'); }, 3000); });
  const before = (await service.targets()).length;
  const aborts = [];
  for (let i = 0; i < 40; i += 1) {
    aborts.push(new Promise(resolve => {
      const s = net.connect(service.port, '127.0.0.1');
      s.on('error', () => {}); s.on('close', resolve);
      s.write(`GET /${site.url('/slowpage')}?i=${i} HTTP/1.1\r\nHost: a\r\nUser-Agent: Googlebot\r\n\r\n`);
      setTimeout(() => s.destroy(), 300);
    }));
  }
  await Promise.all(aborts);
  await sleep(35000);
  const after = (await service.targets()).length;
  assert.ok(after <= before + 1, `${after - before} browser tabs are still open after the callers left`);
  await stillWorks('abandoned requests');
});
