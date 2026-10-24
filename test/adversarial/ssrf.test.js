'use strict';

// Can a rendered page make the service reach something private? Every test renders a hostile page from an allowed site and then checks
// that the "private service" (127.0.0.2, a separate address that is not on the allowed list) was never contacted, in any protocol.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { Service, Site, Secret, request, sleep, skipReason } = require('../lab/lab');

let service; let site; let secret; let hostsEdited = false;

test.before(async () => {
  if (skipReason) return;
  secret = await new Secret().start();
  site = await new Site('127.0.0.1').start();
  // A public-looking name that resolves to a private address: the classic DNS trick. Needs permission to edit /etc/hosts.
  try { fs.appendFileSync('/etc/hosts', '\n127.0.0.2 internal.rebind.test\n'); hostsEdited = true; } catch { /* the DNS test is skipped */ }
  service = await new Service({ ALLOWED_HOSTS: '127.0.0.1,localhost' }).start();
});

test.after(async () => {
  if (skipReason) return;
  await service.stop(); await site.stop(); await secret.stop();
  if (hostsEdited) fs.writeFileSync('/etc/hosts', fs.readFileSync('/etc/hosts', 'utf8').replace('\n127.0.0.2 internal.rebind.test\n', ''));
});

/** Serve `markup` as a page of the allowed site, render it, wait for late requests, and say what the private service saw. */
async function attack(markup, extraRoutes = {}) {
  const name = `/p${Math.random().toString(16).slice(2)}`;
  site.html(name, `<!doctype html><html><head><title>t</title></head><body>${markup}</body></html>`);
  for (const [route, handler] of Object.entries(extraRoutes)) site.route(route, handler);
  secret.http.length = 0; secret.tcp.length = 0; secret.udp.length = 0;
  const res = await service.render(site.url(name), { timeout: 60000 });
  await sleep(1200);
  return { res, saw: secret.describe(), contacted: secret.contacted };
}

const script = code => `<script>${code}</script>`;
const S = () => secret.origin;

test('a page cannot fetch, load or submit to a private address', { skip: skipReason, timeout: 120000 }, async () => {
  const { res, saw, contacted } = await attack(`
    <img src="${S()}/img"><link rel="stylesheet" href="${S()}/css"><script src="${S()}/js"></script>
    <iframe src="${S()}/frame"></iframe><video src="${S()}/video"></video>
    <form id="f" method="POST" action="${S()}/form"><input name="a" value="b"></form>
    ${script(`
      fetch('${S()}/fetch', { mode: 'no-cors' }).catch(() => {});
      var x = new XMLHttpRequest(); x.open('GET', '${S()}/xhr'); x.send();
      navigator.sendBeacon('${S()}/beacon', 'x');
      document.getElementById('f').submit();
    `)}`);
  assert.ok(res.status, 'the page rendered');
  assert.equal(contacted, 0, `the private service was contacted: ${saw}`);
});

test('a redirect from the allowed site to a private address is not followed (main page and subresource)', { skip: skipReason, timeout: 120000 }, async () => {
  const redirect = (req, res) => { res.writeHead(302, { location: `${S()}/redirected` }); res.end(); };
  const sub = await attack(`${script(`fetch('/to-secret', { mode: 'no-cors' }).catch(() => {});`)}<img src="/to-secret">`, { '/to-secret': redirect });
  assert.equal(sub.contacted, 0, `a subresource redirect reached the private service: ${sub.saw}`);
  site.route('/main-redirect', redirect);
  secret.http.length = 0;
  await service.render(site.url('/main-redirect'), { timeout: 60000 });
  await sleep(800);
  assert.equal(secret.contacted, 0, `a redirect of the rendered page reached the private service: ${secret.describe()}`);
});

test('a frame from another site (its own browser process) cannot reach a private address', { skip: skipReason, timeout: 120000 }, async () => {
  // localhost and 127.0.0.1 are different sites, so Chromium isolates the frame in its own process.
  site.html('/inner', script(`fetch('${S()}/from-oopif', { mode: 'no-cors' }).catch(() => {}); new Image().src = '${S()}/oopif-img'; new WebSocket('ws://127.0.0.2:${secret.port}/oopif-ws');`));
  const { saw, contacted } = await attack(`<iframe src="http://localhost:${site.port}/inner"></iframe>`);
  assert.equal(contacted, 0, `a cross-site frame reached the private service: ${saw}`);
});

test('a popup cannot reach a private address', { skip: skipReason, timeout: 120000 }, async () => {
  const { saw, contacted } = await attack(script(`
    window.open('${S()}/popup'); window.open('${S()}/popup2', '_blank', 'noopener');
    var a = document.createElement('a'); a.href = '${S()}/popup3'; a.target = '_blank'; document.body.appendChild(a); a.click();
  `));
  assert.equal(contacted, 0, `a popup reached the private service: ${saw}`);
});

test('a WebSocket cannot connect to a private address', { skip: skipReason, timeout: 120000 }, async () => {
  const { saw, contacted } = await attack(script(`
    new WebSocket('ws://127.0.0.2:${secret.port}/ws'); new WebSocket('ws://127.0.0.2:${secret.rawPort}/raw');
    new EventSource('${S()}/sse');
  `));
  assert.equal(contacted, 0, `a WebSocket or event stream reached the private service: ${saw}`);
});

test('WebRTC cannot send UDP packets to a private address', { skip: skipReason, timeout: 120000 }, async () => {
  const { saw, contacted } = await attack(script(`
    var pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.2:${secret.udpPort}' }] });
    pc.createDataChannel('x'); pc.createOffer().then(function (o) { return pc.setLocalDescription(o); });
  `));
  assert.equal(contacted, 0, `WebRTC reached the private service: ${saw}`);
});

test('a public-looking name that resolves to a private address is refused', { skip: skipReason, timeout: 120000 }, async t => {
  if (!hostsEdited) { t.skip('cannot edit /etc/hosts'); return; }
  const { saw, contacted } = await attack(`<img src="http://internal.rebind.test:${secret.port}/dns"> ${script(`fetch('http://internal.rebind.test:${secret.port}/dns-fetch', { mode: 'no-cors' }).catch(() => {});`)}`);
  assert.equal(contacted, 0, `a name that resolves to a private address reached the private service: ${saw}`);
});

test('numeric spellings of a private address do not get through', { skip: skipReason, timeout: 120000 }, async () => {
  const spellings = ['2130706434', '0x7f000002', '0177.0.0.2', '127.2', '[::ffff:127.0.0.2]', '[::ffff:7f00:2]'];
  const { saw, contacted } = await attack(spellings.map(s => `<img src="http://${s}:${secret.port}/n">`).join(''));
  assert.equal(contacted, 0, `a numeric spelling reached the private service: ${saw}`);
});

test('a page cannot reach or take over the browser through its debugging port', { skip: skipReason || (Boolean(process.env.SERVICE_URL) && 'needs the debugging port'), timeout: 120000 }, async () => {
  const version = await request(`http://127.0.0.1:${service.debugPort}/json/version`, { timeout: 5000 });
  const socketUrl = JSON.parse(version.body).webSocketDebuggerUrl;
  const { res } = await attack(script(`
    document.title = 'pending';
    fetch('http://127.0.0.1:${service.debugPort}/json/version').then(function (r) { return r.text(); }).then(function (t) { document.title = 'READ:' + t.slice(0, 40); }).catch(function () {});
    var ws = new WebSocket('${socketUrl}');
    ws.onopen = function () { document.title = 'CDP-OPEN'; };
  `));
  assert.doesNotMatch(res.body, /CDP-OPEN|READ:/, 'the page reached the browser debugging port');
});

test('a page cannot read local files', { skip: skipReason, timeout: 120000 }, async () => {
  fs.writeFileSync('/tmp/lab-local-secret.txt', 'LOCAL-FILE-CONTENT');
  const { res } = await attack(`
    <iframe src="file:///tmp/lab-local-secret.txt"></iframe><object data="file:///tmp/lab-local-secret.txt"></object>
    ${script(`
      fetch('file:///tmp/lab-local-secret.txt').then(function (r) { return r.text(); }).then(function (t) { document.title = 'READ:' + t; }).catch(function () {});
      var x = new XMLHttpRequest(); x.open('GET', 'file:///tmp/lab-local-secret.txt'); x.onload = function () { document.title = 'XHR:' + x.responseText; }; try { x.send(); } catch (e) {}
    `)}`);
  assert.doesNotMatch(res.body, /LOCAL-FILE-CONTENT/, 'the page read a local file');
  const nav = site.html('/to-file', '<meta http-equiv="refresh" content="0;url=file:///tmp/lab-local-secret.txt">');
  const viaNav = await service.render(site.url('/to-file'), { timeout: 60000 });
  assert.doesNotMatch(viaNav.body || '', /LOCAL-FILE-CONTENT/, 'navigating the rendered page to a local file exposed it');
  void nav;
});

test('browser-internal and non-web schemes do not leak anything', { skip: skipReason, timeout: 120000 }, async () => {
  const { res } = await attack(`<iframe src="chrome://version"></iframe><iframe src="view-source:${site.url('/')}"></iframe>
    <meta http-equiv="refresh" content="0;url=chrome://version">`);
  assert.doesNotMatch(res.body || '', /Google Chrome|Chromium \d|Revision/, 'a browser-internal page was rendered');
});

test('the service is still healthy after all of the above', { skip: skipReason }, async () => {
  assert.ok(service.alive(), service.log.slice(-2000));
  const ok = await service.render(site.url('/'));
  assert.ok(ok.status, 'it still renders');
});
