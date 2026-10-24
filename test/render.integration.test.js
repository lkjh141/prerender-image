'use strict';

// Runs the real server with a real Chromium against a small local page. It needs a Chromium binary: set CHROME_BIN, or run it inside the
// image (where /usr/bin/chromium exists). Without one the test is skipped, so `npm test` still works on a machine without a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');

const chrome = process.env.CHROME_BIN || '/usr/bin/chromium';
const skip = fs.existsSync(chrome) ? false : `no Chromium at ${chrome} (set CHROME_BIN)`;

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function get(port, requestPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: requestPath }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

async function waitFor(check, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (Date.now() > end) throw new Error('timed out waiting for the server');
    await new Promise(r => setTimeout(r, 250));
  }
}

test('renders a script-built page, honours the status meta tag, refuses other hosts and blocks private addresses', { skip, timeout: 120000 }, async t => {
  // A "private" service the rendered page tries to reach; it must never be contacted.
  let privateHits = 0;
  const secret = http.createServer((req, res) => { privateHits += 1; res.end('secret'); });
  const secretPort = await listen(secret, '127.0.0.2'); // really reachable, and not on the allowed host list

  const site = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/missing') {
      res.end('<!doctype html><html><head><meta name="prerender-status-code" content="404"><title>x</title></head><body><div id="r"></div><script>document.getElementById("r").textContent="not found page"</script></body></html>');
      return;
    }
    res.end(`<!doctype html><html><head><title>t</title></head><body><div id="r">loading</div><script>
      document.getElementById('r').textContent = 'rendered by script';
      fetch('http://127.0.0.2:${secretPort}/steal').then(r => r.text()).then(x => { document.title = 'leaked ' + x; }).catch(() => { document.title = 'blocked'; });
    </script></body></html>`);
  });
  const sitePort = await listen(site);

  const servicePort = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(servicePort), CHROME_BIN: chrome, ALLOWED_HOSTS: '127.0.0.1', BROWSER_DEBUGGING_PORT: String(servicePort + 1), LOG_REQUESTS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  t.after(() => { child.kill('SIGTERM'); site.close(); secret.close(); });

  await waitFor(async () => (await get(servicePort, '/http://127.0.0.1:1/')).status > 0);
  await waitFor(() => /Started/.test(output));

  const page = await get(servicePort, `/http://127.0.0.1:${sitePort}/`);
  assert.equal(page.status, 200, output);
  assert.match(page.body, /rendered by script/, 'the page was built by its script');
  assert.doesNotMatch(page.body, /<script/i, 'script tags are removed');
  assert.match(page.body, /<title>blocked<\/title>/, 'the request to a private address was refused inside the browser');
  assert.equal(privateHits, 0, 'the private service was never contacted');

  const missing = await get(servicePort, `/http://127.0.0.1:${sitePort}/missing`);
  assert.equal(missing.status, 404, 'the status meta tag is honoured');
  assert.match(missing.body, /not found page/);
  assert.doesNotMatch(missing.body, /prerender-status-code/, 'the meta tag is removed from the result');

  for (const refused of ['/http://example.org/', '/http://169.254.169.254/latest/meta-data/', '/file:///etc/passwd', `/render?url=${encodeURIComponent('http://localhost:1/')}`]) {
    assert.equal((await get(servicePort, refused)).status, 403, refused);
  }
});

test('the server refuses to start without a host list', { skip }, async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, CHROME_BIN: chrome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stderr.on('data', d => { output += d; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.match(output, /ALLOWED_HOSTS/);
});
