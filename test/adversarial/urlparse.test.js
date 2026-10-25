'use strict';

// Can a request path make the allowlist check and the browser disagree about which host is meant? The allowed site is 127.0.0.1;
// the "private service" is 127.0.0.2 on its own port. Every spelling below is sent as the path of a render request. Whatever the
// service answers, the private service must never be contacted, and every request must be answered (never a hang or a crash).
const test = require('node:test');
const assert = require('node:assert/strict');
const { Service, Site, Secret, rawExchange, sleep, skipReason } = require('../lab/lab');

let service; let site; let secret;

test.before(async () => {
  if (skipReason) return;
  secret = await new Secret().start();
  site = await new Site('127.0.0.1').start();
  site.html('/ok', '<!doctype html><title>ok</title><body>ok</body>');
  service = await new Service({ ALLOWED_HOSTS: '127.0.0.1', PAGE_LOAD_TIMEOUT_MS: '3000', REQUEST_TIMEOUT_MS: '8000' }).start();
});
test.after(async () => { if (skipReason) return; await service.stop(); await site.stop(); await secret.stop(); });

const skip = skipReason || false;
const status = text => Number((/^HTTP\/1\.1 (\d{3})/.exec(text) || [])[1] || 0);

test('no spelling of a host lets the browser go somewhere other than the allowed host', { skip, timeout: 240000 }, async () => {
  const good = `127.0.0.1:${site.port}`;
  const evil = `127.0.0.2:${secret.port}`;
  const candidates = [
    `http://${good}@${evil}/`, `http://${evil}@${good}/ok`, `http://${good}%40${evil}/`, `http://${good}\\@${evil}/`, `http://${good}\\${evil}/`,
    `http://${good}#@${evil}/`, `http://${good}?@${evil}/`, `http://${good}%2f@${evil}/`, `http://${good}%5c@${evil}/`, `http://${good}/@${evil}/`,
    `http://${good}.${evil}/`, `http://${good}%00.${evil}/`, `http://${good}%09@${evil}/`, `http://${good}%0d%0a@${evil}/`,
    `http://127.0.0.1.:${site.port}/ok`, `http://0x7f.0.0.1:${site.port}/ok`, `http://2130706433:${site.port}/ok`, `http://127.1:${site.port}/ok`,
    `http://[::ffff:127.0.0.2]:${secret.port}/`, `http://[::ffff:7f00:2]:${secret.port}/`, `http://0x7f000002:${secret.port}/`,
    `http:/${evil}/`, `http:\\\\${evil}/`, `http:///${evil}/`, `https:${evil}/`, `//${evil}/`, `${evil}/`,
    `http://${evil}/`, `HTTP://${evil}/`, `hTTp://${evil}/`, `http://%31%32%37.0.0.2:${secret.port}/`, `http://127.0.0.2%2e:${secret.port}/`,
    `http://${good}/ok/../../${evil}/`, `http://${good}/ok%2f..%2f..%2f${evil}`, `http://${good}/ok?u=http://${evil}/`,
    `data:text/html,<script>fetch('http://${evil}/')</script>`, `javascript:fetch('http://${evil}/')`, `file:///etc/passwd`, `ftp://${evil}/`,
    `http://127\u30020\u30020\u30022:${secret.port}/`, `http://127.0.0.2\u00ad:${secret.port}/`, `http://127.0.0.2.:${secret.port}/`, `http://0177.0.0.2:${secret.port}/`,
    `http://[0:0:0:0:0:ffff:7f00:2]:${secret.port}/`, `http://[::127.0.0.2]:${secret.port}/`, `http://[64:ff9b::7f00:2]:${secret.port}/`, `http://[2002:7f00:2::]:${secret.port}/`,
    `http://127.0.0.2:${secret.port}\u3002/`, `http://\uff11\uff12\uff17.0.0.2:${secret.port}/`, `http://localhost:${secret.port}/`, `http://LOCALHOST.:${secret.port}/`,
    `http://${good}/ok\r\nHost: ${evil}`, `http://${good}/ok%0d%0aHost:%20${evil}`,
  ];
  const outcomes = {};
  for (const candidate of candidates) {
    const text = await rawExchange(service.port, `GET /${candidate.replace(/[\r\n]/g, c => (c === '\r' ? '%0d' : '%0a'))} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, { timeout: 15000 });
    outcomes[candidate] = status(text);
  }
  // A second pass sends the raw bytes (a request line cannot hold them, so the service must refuse or ignore them).
  for (const candidate of ['\r\nHost: ' + evil, '\t' + evil]) {
    await rawExchange(service.port, `GET /http://${good}/ok${candidate} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`, { timeout: 8000 });
  }
  await sleep(1500);
  assert.equal(secret.contacted, 0, `the private service was contacted: ${secret.describe()}; outcomes ${JSON.stringify(outcomes)}`);
  // The allowed site may well be asked for odd paths (text after the host that the URL parser reads as a path). That is harmless:
  // the request still goes to the allowed host. Only the private service being reached would be a flaw.
  assert.ok(Object.values(outcomes).every(code => code > 0), `every request got an answer: ${JSON.stringify(outcomes)}`);
});

test('the service is still healthy after the URL abuse', { skip, timeout: 60000 }, async () => {
  const res = await service.render(site.url('/ok'), { timeout: 30000 });
  assert.equal(res.status, 200);
});
