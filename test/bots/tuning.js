'use strict';

// Speed against completeness: how short can the waiting be before content that arrives late is lost, and what does the
// window.prerenderReady signal buy? Renders a blog page whose comments arrive ~1.1 s after load (?late=1), with and without the signal (&ready=1).
//
//   CHROME_BIN=/path/to/chromium node test/bots/tuning.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Service, listen, percentile } = require('../lab/lab');
const { startApi, SITE } = require('./run');

const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
const VARIANTS = [
  ['default (500 ms quiet, 100 ms checks)', {}],
  ['quiet 300 ms', { WAIT_AFTER_LAST_REQUEST_MS: '300' }],
  ['quiet 200 ms', { WAIT_AFTER_LAST_REQUEST_MS: '200' }],
  ['quiet 100 ms', { WAIT_AFTER_LAST_REQUEST_MS: '100' }],
  ['quiet 500 ms + BLOCK_RESOURCES', { BLOCK_RESOURCES: 'true' }],
  ["Prerender's own timing (500 ms checks)", { PAGE_DONE_CHECK_INTERVAL_MS: '500' }],
];

async function main() {
  const api = await startApi();
  const site = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const up = http.request({ host: '127.0.0.1', port: api.port, path: req.url, method: 'GET' }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
      up.on('error', () => { res.writeHead(502); res.end(); }); up.end(); return;
    }
    // Only these three files exist; every other path is the app shell. No part of the request is ever used to build a file path.
    const name = ({ '/app.js': 'app.js', '/app.css': 'app.css' })[req.url.split('?')[0]] || 'index.html';
    res.writeHead(200, { 'content-type': TYPES[path.extname(name)] }); res.end(fs.readFileSync(path.join(SITE, name)));
  });
  const sitePort = await listen(site);
  const rows = [];
  for (const [label, env] of VARIANTS) {
    const svc = await new Service({ ALLOWED_HOSTS: '127.0.0.1', ...env }).start();
    const result = { label };
    for (const [key, query] of [['plain', ''], ['late', '?late=1'], ['late+signal', '?late=1&ready=1']]) {
      const ms = []; let complete = 0;
      for (let i = 0; i < 12; i += 1) {
        const r = await svc.render(`http://127.0.0.1:${sitePort}/blog/stage-lighting-basics${query}${query ? '&' : '?'}i=${i}`, { timeout: 60000 });
        ms.push(r.ms);
        if (r.status === 200 && /Maya/.test(r.body) && /Jonas/.test(r.body)) complete += 1;
      }
      result[key] = { complete: `${complete}/12`, p50: percentile(ms, 50) };
    }
    rows.push(result);
    await svc.stop();
  }
  console.log('| setting | comments after 0.5 s: complete / p50 ms | comments after 1.1 s: complete / p50 ms | 1.1 s with prerenderReady: complete / p50 ms |');
  console.log('| --- | --- | --- | --- |');
  for (const r of rows) console.log(`| ${r.label} | ${r.plain.complete} / ${r.plain.p50} | ${r.late.complete} / ${r.late.p50} | ${r['late+signal'].complete} / ${r['late+signal'].p50} |`);
  site.close(); api.server.close();
}
main().catch(e => { console.error(e); process.exit(1); });
