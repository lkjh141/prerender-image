'use strict';

// TLS against many kinds of server. A throw-away certificate authority is made and trusted by the browser in a private
// certificate store (a temporary HOME), so each defect can be tested on its own: a chain that is fine must render, and every
// chain or protocol that Chromium should reject must not return the page it served.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http2 = require('node:http2');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { Service, listen, EXTERNAL, skipReason } = require('../lab/lab');

const have = cmd => { try { execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }); return true; } catch { return false; } };
const skip = skipReason || EXTERNAL || !have('openssl') || !have('certutil') ? 'needs Chromium, openssl and certutil (and not an external service)' : false;
const MARKER = 'TLS-SERVED-CONTENT-4821';
const html = `<!doctype html><title>t</title><body>${MARKER}</body>`;

let dir; let home; let service; const servers = [];
const run = (...args) => execFileSync('openssl', args, { stdio: 'ignore', cwd: dir });

/** A certificate authority in its own directory that can issue leaves with chosen dates, names and chains. */
function makeCa(name, { issuer = null } = {}) {
  const base = path.join(dir, name);
  fs.mkdirSync(path.join(base, 'new'), { recursive: true });
  fs.writeFileSync(path.join(base, 'index.txt'), '');
  fs.writeFileSync(path.join(base, 'serial'), '1000\n');
  fs.writeFileSync(path.join(base, 'ca.cnf'), `[ca]\ndefault_ca=c\n[c]\ndir=${base}\ndatabase=${base}/index.txt\nnew_certs_dir=${base}/new\nserial=${base}/serial\ndefault_md=sha256\npolicy=p\nunique_subject=no\ncopy_extensions=copy\n[p]\ncommonName=supplied\n`);
  const key = path.join(base, 'ca.key'); const cert = path.join(base, 'ca.pem');
  if (!issuer) {
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', `/CN=${name}`, '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  } else {
    const csr = path.join(base, 'ca.csr');
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${name}`);
    fs.writeFileSync(path.join(base, 'ca.ext'), 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    run('ca', '-config', path.join(issuer.base, 'ca.cnf'), '-batch', '-notext', '-in', csr, '-out', cert, '-days', '20', '-extfile', path.join(base, 'ca.ext'), '-keyfile', issuer.key, '-cert', issuer.cert);
  }
  return { base, key, cert };
}

/** A leaf for `names`, signed by `ca`, valid between the given dates (or for 10 days). */
function leaf(ca, label, { names = ['IP:127.0.0.1'], start = null, end = null } = {}) {
  const key = path.join(dir, `${label}.key`); const csr = path.join(dir, `${label}.csr`); const cert = path.join(dir, `${label}.pem`);
  run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', `/CN=${label}`);
  const ext = path.join(dir, `${label}.ext`);
  fs.writeFileSync(ext, `subjectAltName=${names.join(',')}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`);
  const dates = start ? ['-startdate', start, '-enddate', end] : ['-days', '10'];
  run('ca', '-config', path.join(ca.base, 'ca.cnf'), '-batch', '-notext', '-in', csr, '-out', cert, ...dates, '-extfile', ext, '-keyfile', ca.key, '-cert', ca.cert);
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

async function serve(options, kind = 'https') {
  const handler = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); };
  const server = kind === 'h2' ? http2.createSecureServer({ ...options, allowHTTP1: true }, handler) : https.createServer(options, handler);
  const port = await listen(server);
  servers.push(server);
  return port;
}

const cases = {}; // name -> { port, mustRender }
test.before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlsmatrix-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tlshome-'));
  fs.mkdirSync(path.join(home, '.pki', 'nssdb'), { recursive: true });
  const db = `sql:${path.join(home, '.pki', 'nssdb')}`;
  execFileSync('certutil', ['-N', '-d', db, '--empty-password'], { stdio: 'ignore' });

  const root = makeCa('labroot');
  execFileSync('certutil', ['-A', '-d', db, '-n', 'labroot', '-t', 'C,,', '-i', root.cert], { stdio: 'ignore' });
  const other = makeCa('untrustedroot'); // never imported
  const inter = makeCa('labinter', { issuer: root });
  const chain = Buffer.concat([fs.readFileSync(inter.cert)]);
  const withChain = pair => ({ key: pair.key, cert: Buffer.concat([pair.cert, chain]) });

  const good = leaf(root, 'good');
  const viaInter = leaf(inter, 'viainter');
  cases['trusted chain'] = { port: await serve(good), mustRender: true };
  cases['trusted chain through an intermediate that the server sends'] = { port: await serve(withChain(viaInter)), mustRender: true };
  cases['trusted chain, HTTP/2'] = { port: await serve(good, 'h2'), mustRender: true };
  cases['TLS 1.2 only'] = { port: await serve({ ...good, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' }), mustRender: true };
  cases['TLS 1.3 only'] = { port: await serve({ ...good, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }), mustRender: true };

  cases['expired certificate'] = { port: await serve(leaf(root, 'expired', { start: '20200101000000Z', end: '20200102000000Z' })), mustRender: false };
  cases['certificate not valid yet'] = { port: await serve(leaf(root, 'future', { start: '20400101000000Z', end: '20400102000000Z' })), mustRender: false };
  cases['certificate for another name'] = { port: await serve(leaf(root, 'wrongname', { names: ['DNS:other.example', 'IP:10.9.9.9'] })), mustRender: false };
  cases['self-signed certificate'] = { port: await serve(selfSignedPair()), mustRender: false };
  cases['chain from an authority that is not trusted'] = { port: await serve(leaf(other, 'untrusted')), mustRender: false };
  cases['intermediate missing from the chain'] = { port: await serve(viaInter), mustRender: false };
  cases['TLS 1.0 only'] = { port: await serve({ ...good, minVersion: 'TLSv1', maxVersion: 'TLSv1', ciphers: 'DEFAULT:@SECLEVEL=0' }), mustRender: false };
  cases['TLS 1.1 only'] = { port: await serve({ ...good, minVersion: 'TLSv1.1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT:@SECLEVEL=0' }), mustRender: false };

  service = await new Service({ HOME: home, PAGE_LOAD_TIMEOUT_MS: '6000', REQUEST_TIMEOUT_MS: '20000' }).start();
});
test.after(async () => {
  if (skip) return;
  await service.stop();
  for (const server of servers) { server.closeAllConnections?.(); server.close(); }
});

function selfSignedPair() {
  const key = path.join(dir, 'ss.key'); const cert = path.join(dir, 'ss.pem');
  run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', '/CN=ss', '-addext', 'subjectAltName=IP:127.0.0.1');
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const expected = [
  'trusted chain', 'trusted chain through an intermediate that the server sends', 'trusted chain, HTTP/2', 'TLS 1.2 only', 'TLS 1.3 only',
  'expired certificate', 'certificate not valid yet', 'certificate for another name', 'self-signed certificate', 'chain from an authority that is not trusted',
  'intermediate missing from the chain', 'TLS 1.0 only', 'TLS 1.1 only',
];
for (const name of expected) {
  test(`TLS: ${name}`, { skip, timeout: 90000 }, async () => {
    const { port, mustRender } = cases[name];
    const res = await service.render(`https://127.0.0.1:${port}/`, { timeout: 60000 });
    if (mustRender) {
      assert.equal(res.status, 200, `a good server was refused (${res.status})`);
      assert.match(res.body || '', new RegExp(MARKER), 'the page of a good server was not rendered');
    } else {
      assert.doesNotMatch(res.body || '', new RegExp(MARKER), `the page behind "${name}" was rendered and returned`);
    }
  });
}

test('TLS: the service is still healthy after the matrix', { skip, timeout: 30000 }, async () => {
  assert.ok(tls.DEFAULT_MIN_VERSION);
  const res = await service.render(`https://127.0.0.1:${cases['trusted chain'].port}/`, { timeout: 30000 });
  assert.equal(res.status, 200);
});
