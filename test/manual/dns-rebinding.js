'use strict';

// DNS rebinding with a real, changing DNS answer. Not part of `npm test`: it needs root (it listens on UDP port 53 and points
// /etc/resolv.conf at itself for the duration, then puts the file back) and a private "secret" web server on 127.0.0.2:80.
//   FIRST=8.8.8.8 SECOND=127.0.0.2 CHROME_BIN=/path/to/chromium node test/manual/dns-rebinding.js
// Names under rebind.test are answered with FIRST, then SECOND, then FIRST ... (time to live 0). An allowed page asks for 12 such
// names, 6 times each, as fetches and as images. The secret server must receive nothing, whatever the order of the answers, because
// the egress proxy resolves a name once, refuses it if any answer is private, and connects to the address it checked.
const dgram = require('dgram'); const http = require('http'); const fs = require('fs');
const { Service, Site, sleep } = require('../lab/lab');
const ORIGINAL = fs.readFileSync('/etc/resolv.conf');
let flips = 0; const answers = [];
function build(q, ip) { // minimal A response
  const id = q.subarray(0, 2); let i = 12; while (q[i] !== 0) i += q[i] + 1; const qend = i + 5; const question = q.subarray(12, qend);
  const head = Buffer.from([id[0], id[1], 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
  const ans = Buffer.concat([Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4]), Buffer.from(ip.split('.').map(Number))]);
  return Buffer.concat([head, question, ans]);
}
const dns = dgram.createSocket('udp4');
const name = q => { const parts = []; let i = 12; while (q[i]) { parts.push(q.subarray(i + 1, i + 1 + q[i]).toString()); i += q[i] + 1; } return parts.join('.'); };
dns.on('message', (q, rinfo) => {
  const n = name(q); const type = q.readUInt16BE(12 + n.length + 2);
  if (n.endsWith('.rebind.test')) {
    if (type !== 1) { const r = Buffer.from(build(q, '1.1.1.1')); r.writeUInt16BE(0, 6); dns.send(r.subarray(0, 12 + n.length + 2 + 4), rinfo.port, rinfo.address); return; }
    const ip = (flips++ % 2 === 0) ? process.env.FIRST : process.env.SECOND; answers.push(`${n}->${ip}`); dns.send(build(q, ip), rinfo.port, rinfo.address); return;
  }
  const up = dgram.createSocket('udp4'); up.send(q, 53, '8.8.8.8'); up.on('message', m => { dns.send(m, rinfo.port, rinfo.address); up.close(); });
});
(async () => {
  await new Promise(r => dns.bind(53, '127.0.0.1', r));
  fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.1\noptions timeout:2 attempts:2\n');
  const secretHits = [];
  const secret = http.createServer((q, s) => { secretHits.push(q.headers.host + q.url); s.writeHead(200, { 'access-control-allow-origin': '*' }); s.end('SECRET'); });
  await new Promise(r => secret.listen(80, '127.0.0.2', r));
  const site = await new Site('127.0.0.1').start();
  const targets = Array.from({ length: 12 }, (_, i) => `http://flip${i}.rebind.test/secret`);
  site.html('/p', `<!doctype html><title>p</title><body><div id=o>x</div><script>${JSON.stringify(targets)}.forEach(function(u,i){for(var k=0;k<6;k++){fetch(u+"?"+k,{mode:"no-cors"}).catch(function(){});var im=new Image();im.src=u+"?img"+k}});setTimeout(function(){document.getElementById("o").textContent="rebind page rendered"},300)</script></body>`);
  const svc = await new Service({ ALLOWED_HOSTS: '127.0.0.1' }).start();
  const res = await svc.render(site.url('/p'), { timeout: 60000 });
  await sleep(3000);
  const clean = secretHits.length === 0 && /rebind page rendered/.test(res.body);
  console.log(`${clean ? 'OK' : 'PROBLEM'} FIRST=${process.env.FIRST} SECOND=${process.env.SECOND}: rendered=${/rebind page rendered/.test(res.body)} dns answers=${answers.length} secret hits=${secretHits.length} ${JSON.stringify(secretHits.slice(0, 3))}`);
  console.log('blocked lines:', svc.log.split('\n').filter(l => /egress blocked/.test(l)).length, '|', (svc.log.split('\n').find(l => /egress blocked/.test(l)) || '').slice(0, 140));
  await svc.stop(); await site.stop(); secret.close(); dns.close();
})().catch(e => console.log('ERR', e)).finally(() => { fs.writeFileSync('/etc/resolv.conf', ORIGINAL); setTimeout(() => process.exit(0), 300); });
