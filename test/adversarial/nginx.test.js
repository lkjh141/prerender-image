'use strict';

// The service behind the nginx configuration of docs/nginx.example.conf (with plain http and local ports instead of the public address).
// What a visitor or crawler can do through nginx must not reach further than what the service itself allows: crawlers get rendered pages,
// other visitors get the app shell, static files are not rendered, the service's own browser is never sent back to it, odd request lines
// and Host headers do not change which site is rendered, and when the service is down crawlers still get the app shell.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Service, Site, Secret, request, rawExchange, listen, sleep, skipReason, EXTERNAL } = require('../lab/lab');
const net = require('node:net');

const haveNginx = (() => { try { execFileSync('sh', ['-c', 'command -v nginx || test -x /usr/sbin/nginx'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const nginxBin = haveNginx ? execFileSync('sh', ['-c', 'command -v nginx || echo /usr/sbin/nginx'], { encoding: 'utf8' }).trim() : 'nginx';
const skip = skipReason || EXTERNAL || !haveNginx ? 'needs Chromium and nginx (and not an external service)' : false;

let dir; let nginx; let nginxPort; let service; let site; let secret; let svcDown = false;

const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function conf(servicePort, sitePort) {
  const crawlers = 'googlebot|bingbot|gptbot|claudebot|facebookexternalhit';
  return `
worker_processes 1; daemon off; pid ${dir}/nginx.pid; error_log ${dir}/error.log warn;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${dir}/t1; proxy_temp_path ${dir}/t2; fastcgi_temp_path ${dir}/t3; uwsgi_temp_path ${dir}/t4; scgi_temp_path ${dir}/t5;
  map $http_user_agent $is_crawler { default 0; "~*(${crawlers})" 1; }
  map $http_user_agent $is_prerender_browser { default 0; "~*prerender" 1; }
  map "$is_crawler:$is_prerender_browser:$uri" $send_to_prerender { default 0; "~*^1:0:.*\\.[a-z0-9]{1,6}$" 0; "~^1:0:" 1; }
  server {
    listen 127.0.0.1:${nginxPort};
    root ${dir}/app;
    location / {
      if ($send_to_prerender) { rewrite ^ /__prerender last; }
      try_files $uri /index.html;
    }
    location = /__prerender {
      internal;
      proxy_pass http://127.0.0.1:${servicePort}/http://127.0.0.1:${sitePort}$request_uri;
      proxy_read_timeout 30s;
      proxy_intercept_errors on;
      error_page 500 502 503 504 = @without_prerender;
    }
    location @without_prerender { try_files /index.html =404; }
  }
}`;
}

test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nginxlab-'));
  fs.chmodSync(dir, 0o755); // nginx's worker may run as another user
  fs.mkdirSync(path.join(dir, 'app'), { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'app', 'index.html'), '<!doctype html><title>shell</title><body>APP-SHELL-ONLY</body>');
  fs.writeFileSync(path.join(dir, 'app', 'app.js'), 'console.log("STATIC-FILE")');
  secret = await new Secret().start();
  site = await new Site('127.0.0.1').start();
  site.html('/', '<!doctype html><title>home</title><body><div id=o>x</div><script>document.getElementById("o").textContent="RENDERED-HOME"</script>');
  site.html('/news', '<!doctype html><title>news</title><body><div id=o>x</div><script>document.getElementById("o").textContent="RENDERED-NEWS "+location.search</script>');
  site.html('/ua', '<!doctype html><title>ua</title><body><div id=o>x</div><script>document.getElementById("o").textContent="UA "+navigator.userAgent</script>');
  service = await new Service({ ALLOWED_HOSTS: '127.0.0.1' }).start();
  nginxPort = await freePort();
  fs.writeFileSync(path.join(dir, 'nginx.conf'), conf(service.servicePort, site.port));
  nginx = spawn(nginxBin, ['-p', dir, '-c', path.join(dir, 'nginx.conf')], { stdio: 'ignore' });
  for (let i = 0; i < 40; i += 1) { const r = await request(`http://127.0.0.1:${nginxPort}/`, { timeout: 2000 }); if (r.status) break; await sleep(100); }
});
test.after(async () => {
  if (skip) return;
  nginx.kill('SIGTERM'); if (!svcDown) await service.stop(); await site.stop(); await secret.stop();
});

const get = (route, ua = 'Mozilla/5.0 (compatible; Googlebot/2.1)', extra = {}) =>
  request(`http://127.0.0.1:${nginxPort}${route}`, { headers: { 'user-agent': ua, ...extra }, timeout: 60000 });

test('nginx: a crawler gets the rendered page, a visitor gets the app shell', { skip, timeout: 120000 }, async () => {
  const bot = await get('/news');
  assert.equal(bot.status, 200);
  assert.match(bot.body, /RENDERED-NEWS/);
  const visitor = await get('/news', 'Mozilla/5.0 (X11; Linux x86_64) Chrome/141');
  assert.match(visitor.body, /APP-SHELL-ONLY/);
  assert.doesNotMatch(visitor.body, /RENDERED/);
});

test('nginx: query strings reach the page, and the page sees a browser that names itself Prerender only inside the service', { skip, timeout: 120000 }, async () => {
  const q = await get('/news?x=1&y=two');
  assert.match(q.body, /RENDERED-NEWS \?x=1&amp;y=two|RENDERED-NEWS \?x=1&y=two/);
  const ua = await get('/ua');
  assert.match(ua.body, /UA .*Chrome/);
});

test('nginx: files with an extension are served as files and a Prerender user agent is not sent back to the service', { skip, timeout: 120000 }, async () => {
  const file = await get('/app.js');
  assert.match(file.body, /STATIC-FILE/);
  const loop = await get('/news', 'Mozilla/5.0 HeadlessChrome Prerender Googlebot');
  assert.match(loop.body, /APP-SHELL-ONLY/, 'the service\'s own browser must get the shell, not another render');
});

test('nginx: odd request targets and Host headers cannot change which site is rendered', { skip, timeout: 240000 }, async () => {
  const before = site.hits.length;
  const evil = `127.0.0.2:${secret.port}`;
  const raw = target => `GET ${target} HTTP/1.1\r\nHost: ${evil}\r\nUser-Agent: Googlebot\r\nX-Forwarded-Host: ${evil}\r\nX-Original-URL: http://${evil}/\r\nConnection: close\r\n\r\n`;
  const targets = [
    `http://${evil}/news`, `http://127.0.0.1:${site.port}@${evil}/`, `//${evil}/`, `/@${evil}/`, `/%40${evil}/`, `/\\${evil}/`, `/..%2f..%2f${evil}/`,
    `/news%0d%0aHost:%20${evil}`, `/news#@${evil}`, `*`, `${evil}`, `/news?u=http://${evil}/`,
  ];
  const codes = {};
  for (const target of targets) {
    const text = await rawExchange(nginxPort, raw(target), { timeout: 20000 });
    codes[target] = Number((/^HTTP\/1\.\d (\d{3})/.exec(text) || [])[1] || 0);
  }
  // Two Host headers, a Host with a port and with a trailing dot, and an X-Forwarded-Host: none of them may matter.
  for (const host of [`${evil}`, '127.0.0.2', 'EVIL.example.', `127.0.0.1:${site.port}`]) {
    await get('/news', 'Googlebot', { host, 'x-forwarded-host': evil });
  }
  await rawExchange(nginxPort, `GET /news HTTP/1.1\r\nHost: a\r\nHost: ${evil}\r\nUser-Agent: Googlebot\r\nConnection: close\r\n\r\n`, { timeout: 20000 });
  await sleep(1500);
  assert.equal(secret.contacted, 0, `the private service was contacted: ${secret.describe()} (${JSON.stringify(codes)})`);
  const strange = site.hits.slice(before).filter(url => !/^\/news/.test(url) && url !== '/favicon.ico' && !url.startsWith('/@') && !url.startsWith('//') && !url.startsWith('/%') && !url.startsWith('/\\') && !url.startsWith('/..'));
  assert.deepEqual(strange, [], 'the site was asked for something nginx should not have produced');
});

test('nginx: when the service is down, crawlers still get the app shell', { skip, timeout: 120000 }, async () => {
  await service.stop(); svcDown = true;
  const bot = await get('/news');
  assert.equal(bot.status, 200);
  assert.match(bot.body, /APP-SHELL-ONLY/);
});
