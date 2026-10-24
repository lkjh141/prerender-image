'use strict';

// What do crawlers and AI bots actually receive? Starts a client-rendered demo site behind nginx, once without prerendering and once with this
// service in front, then asks for every page as every bot and compares what comes back with what a real browser shows a person.
//
//   CHROME_BIN=/path/to/chromium node test/bots/run.js            # prints tables, writes test/bots/report.json
//
// Needs nginx, a Chromium for the service, and Playwright (only to see the page as a person does).
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { Service, request, sleep, percentile, listen } = require('../lab/lab');
const { treeRssMb } = require('../../lib/watchdog');

const SITE = path.join(__dirname, 'site');
const PRODUCTS = [
  { id: 'moving-wash-300', name: 'Moving Wash 300', summary: 'A 300 W LED moving wash with zoom, for stages and theatres.', details: 'Full RGBW colour mixing, 8 to 40 degree zoom and a 16-bit dimmer.', price: 85 },
  { id: 'line-array-12', name: 'Line Array 12', summary: 'A compact two-way line array element for touring sound.', details: 'Twelve-inch woofer, 1.4 inch compression driver and a 90 degree horizontal pattern.', price: 120 },
  { id: 'truss-3m', name: 'Box Truss 3 m', summary: 'A 290 mm box truss section rated for lighting loads.', details: 'Aluminium 6082, includes conical couplers and pins.', price: 25 },
];
const COMMENTS = [{ who: 'Maya', text: 'This finally explained DMX channels to me.' }, { who: 'Jonas', text: 'The grounding section saved our load-in.' }];
const BOTS = {
  Googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  Bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  GPTBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot',
  'ChatGPT-User': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot',
  'OAI-SearchBot': 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot',
  ClaudeBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
  PerplexityBot: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)',
  Applebot: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Safari/605.1.15 (Applebot/0.1; +http://www.apple.com/go/applebot)',
  facebookexternalhit: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
  Twitterbot: 'Twitterbot/1.0',
  LinkedInBot: 'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
};
const HUMAN = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PAGES = ['/', '/products', '/products/moving-wash-300', '/blog/stage-lighting-basics', '/about', '/products/does-not-exist', '/no/such/page'];

function startApi() {
  const server = http.createServer((req, res) => {
    const send = (code, body, delay = 120) => setTimeout(() => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }, delay);
    if (req.url === '/api/products') return send(200, PRODUCTS);
    if (req.url === '/api/comments') return send(200, COMMENTS, 200);
    const m = /^\/api\/products\/([\w-]+)$/.exec(req.url);
    if (m) { const p = PRODUCTS.find(x => x.id === m[1]); return send(p ? 200 : 404, p || { error: 'not found' }); }
    res.writeHead(404); res.end();
  });
  return listen(server).then(port => ({ server, port }));
}

function nginxConf({ dir, port, apiPort, prerenderPort, sitePortForRender }) {
  const render = prerenderPort ? `
    map $http_user_agent $is_bot { default 0; "~*(googlebot|bingbot|gptbot|chatgpt-user|oai-searchbot|claudebot|perplexitybot|applebot|facebookexternalhit|twitterbot|linkedinbot)" 1; }
    map $http_user_agent $is_prerender { default 0; "~*prerender" 1; }
    map "$is_bot:$is_prerender:$uri" $send { default 0; "~*^1:0:.*\\.[a-z0-9]{1,6}$" 0; "~^1:0:" 1; }
    proxy_cache_path ${dir}/cache levels=1:2 keys_zone=pr:10m max_size=50m inactive=10m;` : '';
  const loc = prerenderPort ? `
      location / { if ($send) { rewrite ^ /__prerender last; } try_files $uri /index.html; }
      location = /__prerender {
        internal;
        proxy_pass http://127.0.0.1:${prerenderPort}/http://127.0.0.1:${sitePortForRender}$request_uri;
        proxy_read_timeout 35s;
        proxy_cache pr; proxy_cache_key "$request_uri"; proxy_cache_valid 200 10m; proxy_cache_lock on;
        add_header X-Cache $upstream_cache_status always;
        proxy_intercept_errors on; error_page 500 502 503 504 = @shell;
      }
      location @shell { try_files /index.html =404; }` : '\n      location / { try_files $uri /index.html; }';
  return `worker_processes 1; daemon off; pid ${dir}/nginx.pid; error_log ${dir}/error.log; user root;
events { worker_connections 256; }
http {
  access_log off; client_body_temp_path ${dir}/t1; proxy_temp_path ${dir}/t2; fastcgi_temp_path ${dir}/t3; uwsgi_temp_path ${dir}/t4; scgi_temp_path ${dir}/t5;
  include /etc/nginx/mime.types;${render}
  server {
    listen 127.0.0.1:${port}; root ${SITE};
    location /api/ { proxy_pass http://127.0.0.1:${apiPort}; }${loc}
  }
}
`;
}

const ENTITIES = { '&amp;': '&', '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>' };
// Text of an HTML document for comparison. Tags and the contents of script, style and noscript are removed; entities are decoded in ONE pass,
// so "&amp;lt;" becomes "&lt;" and not "<".
const strip = html => html
  .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1[^>]*>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(?:amp|#39|quot|lt|gt);/g, entity => ENTITIES[entity])
  .replace(/\s+/g, ' ')
  .trim();
const words = text => new Set((text.toLowerCase().match(/[a-z0-9$]+/g) || []).filter(w => w.length > 2));
function facts(html) {
  const get = re => { const m = re.exec(html); return m ? m[1] : ''; };
  let ld = 0; let ldOk = 0;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { ld += 1; try { JSON.parse(m[1]); ldOk += 1; } catch { /* invalid */ } }
  return {
    title: get(/<title[^>]*>([\s\S]*?)<\/title>/i).trim(),
    description: get(/<meta[^>]+name="description"[^>]+content="([^"]*)"/i) || get(/<meta[^>]+content="([^"]*)"[^>]+name="description"/i),
    canonical: get(/<link[^>]+rel="canonical"[^>]+href="([^"]*)"/i),
    ogTitle: get(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i),
    h1: strip(get(/<h1[^>]*>([\s\S]*?)<\/h1>/i)),
    links: (html.match(/<a\s[^>]*href="\/[^"]*"/gi) || []).length,
    ld, ldOk,
    scripts: (html.match(/<script\b(?![^>]*ld\+json)/gi) || []).length,
    text: strip(html),
  };
}

async function main() {
  const chrome = process.env.CHROME_BIN;
  if (!chrome || !fs.existsSync(chrome)) throw new Error('set CHROME_BIN to a Chromium');
  const { chromium } = require('playwright');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bots-'));
  const api = await startApi();
  const plainPort = 18000 + Math.floor(Math.random() * 1000); const renderedPort = plainPort + 1;
  const settings = JSON.parse(process.env.SERVICE_ENV || '{}');
  const svc = await new Service({ ALLOWED_HOSTS: '127.0.0.1', METRICS_ENABLED: 'true', ...settings }).start();
  const procs = [];
  for (const [name, conf] of [['plain', nginxConf({ dir, port: plainPort, apiPort: api.port })], ['rendered', nginxConf({ dir, port: renderedPort, apiPort: api.port, prerenderPort: svc.servicePort, sitePortForRender: renderedPort })]]) {
    const file = path.join(dir, `${name}.conf`); fs.writeFileSync(file, conf);
    for (const d of ['t1', 't2', 't3', 't4', 't5', 'cache']) fs.mkdirSync(path.join(dir, d), { recursive: true });
    const p = spawn('nginx', ['-c', file, '-p', dir], { stdio: 'ignore' });
    procs.push(p);
    await sleep(600);
  }
  const cleanup = async () => { for (const p of procs) p.kill('SIGTERM'); await svc.stop(); api.server.close(); };
  try {
    // 1. What a person sees: the real browser, after the page has settled.
    const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
    const truth = {};
    for (const p of PAGES) {
      const page = await browser.newPage({ userAgent: HUMAN });
      const response = await page.goto(`http://127.0.0.1:${plainPort}${p}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      truth[p] = { text: strip((await page.content()).replace(/<head[\s\S]*?<\/head>/i, ' ')), title: await page.title(), status: p.includes('does-not-exist') || p.includes('no/such') ? 404 : 200, httpStatus: response.status() };
      await page.close();
    }
    await browser.close();

    // 2. What each bot gets, with and without the service.
    const rows = [];
    for (const [mode, port] of [['without prerender', plainPort], ['with prerender', renderedPort]]) {
      for (const [bot, ua] of Object.entries(BOTS)) {
        for (const p of PAGES) {
          const res = await request(`http://127.0.0.1:${port}${p}`, { headers: { 'user-agent': ua }, timeout: 60000 });
          const f = facts(res.body || '');
          const truthWords = words(truth[p].text);
          const got = words(strip((res.body || '').replace(/<head[\s\S]*?<\/head>/i, ' ')));
          const covered = [...truthWords].filter(w => got.has(w)).length;
          rows.push({ mode, bot, page: p, status: res.status, ms: res.ms, bytes: (res.buffer || []).length, coverage: truthWords.size ? covered / truthWords.size : 1, missing: [...truthWords].filter(w => !got.has(w)).slice(0, 8), ...f, text: undefined, cache: res.headers && res.headers['x-cache'] });
        }
      }
    }
    // 3. Cost: time, CPU and memory per rendered page, uncached and cached.
    const cpu = () => { let total = 0; for (const p of [{ pid: svc.pid }, ...svc.processes()]) { try { const s = fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8').split(') ')[1].split(' '); total += (Number(s[11]) + Number(s[12])); } catch { /* gone */ } } return total / 100; };
    const direct = [];
    const cpu0 = cpu(); const t0 = Date.now(); let peakMB = 0;
    for (let i = 0; i < 30; i += 1) {
      const p = PAGES[i % 5];
      const r = await svc.render(`http://127.0.0.1:${plainPort}${p}?cost=${i}`, { timeout: 60000 });
      direct.push(r.ms); peakMB = Math.max(peakMB, treeRssMb(svc.processes().find(x => x.ppid === svc.pid && /chrom/i.test(x.args)).pid));
    }
    const cost = { renders: 30, avgMs: Math.round((Date.now() - t0) / 30), p50: percentile(direct, 50), p95: percentile(direct, 95), cpuSecondsPerPage: Number(((cpu() - cpu0) / 30).toFixed(2)), browserPeakMB: peakMB, serviceMB: Math.round(svc.nodeRssMB()) };
    const cached = [];
    for (let i = 0; i < 50; i += 1) cached.push((await request(`http://127.0.0.1:${renderedPort}${PAGES[i % 5]}`, { headers: { 'user-agent': BOTS.GPTBot } })).ms);
    cost.cachedP50 = percentile(cached, 50); cost.cachedP95 = percentile(cached, 95);
    const out = { generatedWith: path.basename(chrome), rows, cost, truth: Object.fromEntries(Object.entries(truth).map(([k, v]) => [k, { words: words(v.text).size, status: v.status }])) };
    fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(out, null, 1));
    summarize(out);
  } finally { await cleanup(); }
}

function summarize({ rows, cost }) {
  const pct = n => `${Math.round(n * 100)}%`;
  console.log('\n## What bots receive\n');
  console.log('| mode | content seen (words a person sees) | has title | has description | has canonical | has og:title | has h1 | structured data (product page) | internal links (home) | scripts left | 404 pages answered with 404 |');
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const mode of ['without prerender', 'with prerender']) {
    const r = rows.filter(x => x.mode === mode);
    const ok = pred => pct(r.filter(pred).length / r.length);
    const product = r.filter(x => x.page === '/products/moving-wash-300');
    const home = r.filter(x => x.page === '/');
    const notFound = r.filter(x => x.page.includes('does-not-exist') || x.page.includes('no/such'));
    console.log(`| ${mode} | ${pct(r.reduce((s, x) => s + x.coverage, 0) / r.length)} | ${ok(x => x.title && x.title !== 'Loading…')} | ${ok(x => x.description)} | ${ok(x => x.canonical)} | ${ok(x => x.ogTitle)} | ${ok(x => x.h1)} | ${pct(product.filter(x => x.ldOk > 0).length / product.length)} | ${Math.round(home.reduce((s, x) => s + x.links, 0) / home.length)} | ${(r.reduce((s, x) => s + x.scripts, 0) / r.length).toFixed(1)} | ${pct(notFound.filter(x => x.status === 404).length / notFound.length)} |`);
  }
  console.log('\n## Per bot, with prerender\n');
  console.log('| bot | content seen | pages with a title | pages ok |');
  console.log('| --- | --- | --- | --- |');
  for (const bot of Object.keys(BOTS)) {
    const r = rows.filter(x => x.mode === 'with prerender' && x.bot === bot);
    console.log(`| ${bot} | ${pct(r.reduce((s, x) => s + x.coverage, 0) / r.length)} | ${r.filter(x => x.title && x.title !== 'Loading…').length}/${r.length} | ${r.filter(x => x.status === 200 || x.status === 404).length}/${r.length} |`);
  }
  console.log('\n## Cost\n');
  console.log(JSON.stringify(cost, null, 1));
}

if (require.main === module) main().catch(error => { console.error(error); process.exit(1); });

module.exports = { startApi, SITE };
