'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAllowedHosts, isPrivateHost, isAllowedTarget, subrequestBlockReason, loadConfig, createGuardPlugin,
} = require('../lib/guard');

const config = { allowedHosts: ['example.com', 'www.example.com'], allowAnyHost: false, blockResources: false };

test('ALLOWED_HOSTS is read as plain, lower-case, de-duplicated host names', () => {
  assert.deepEqual(parseAllowedHosts('Example.com, www.example.com ,example.com.,'), ['example.com', 'www.example.com']);
  assert.deepEqual(parseAllowedHosts(''), []);
  assert.deepEqual(parseAllowedHosts(undefined), []);
  assert.deepEqual(parseAllowedHosts('127.0.0.1,[::1]'), ['127.0.0.1', '::1']);
});

test('ALLOWED_HOSTS refuses anything that is not a plain host name, so a typo stops the container', () => {
  for (const bad of ['*.example.com', 'https://example.com', 'example.com:8080', 'example.com/path', 'exa mple.com', '-example.com', 'example..com']) {
    assert.throws(() => parseAllowedHosts(bad), /not a plain host name/, bad);
  }
});

test('the container will not start without a host list unless every host is allowed on purpose', () => {
  assert.throws(() => loadConfig({}), /ALLOWED_HOSTS/);
  assert.throws(() => loadConfig({ ALLOWED_HOSTS: ' , ' }), /ALLOWED_HOSTS/);
  assert.deepEqual(loadConfig({ ALLOWED_HOSTS: 'example.com' }), { allowedHosts: ['example.com'], allowAnyHost: false, allowPrivate: false, allowInvalidCerts: false, blockResources: false });
  assert.equal(loadConfig({ ALLOW_ANY_HOST: 'true' }).allowAnyHost, true);
  assert.equal(loadConfig({ ALLOWED_HOSTS: 'a.example', ALLOW_ANY_HOST: 'yes' }).allowAnyHost, false, 'only the word true counts');
  assert.equal(loadConfig({ ALLOWED_HOSTS: 'a.example', BLOCK_RESOURCES: 'TRUE' }).blockResources, true);
});

test('only http and https pages on an allowed host may be rendered', () => {
  for (const ok of ['https://example.com/', 'http://example.com/a?b=c#d', 'https://WWW.Example.COM/x', 'https://example.com./x', 'https://example.com:8443/x']) {
    assert.equal(isAllowedTarget(ok, config), true, ok);
  }
  for (const bad of [
    'https://evil.example/', 'https://example.com.evil.example/', 'https://notexample.com/', 'https://sub.example.com/',
    'https://example.com@evil.example/', 'https://example.com:pass@evil.example/', 'https://user@example.com/',
    'https://evil.example\\@example.com/', 'file:///etc/passwd', 'ftp://example.com/', 'javascript:alert(1)', 'data:text/html,x',
    'http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://localhost/', '', 'example.com', 'https://', null, undefined,
  ]) {
    assert.equal(isAllowedTarget(bad, config), false, String(bad));
  }
});

test('with every host allowed on purpose, web pages pass and other schemes still do not', () => {
  const open = { allowedHosts: [], allowAnyHost: true, blockResources: false };
  assert.equal(isAllowedTarget('https://anything.example/', open), true);
  assert.equal(isAllowedTarget('file:///etc/passwd', open), false);
  assert.equal(isAllowedTarget('https://user@anything.example/', open), false);
});

test('private, loopback, link-local and local-only names are recognised in every spelling the URL parser accepts', () => {
  for (const host of [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:a00:1', 'localhost', 'LOCALHOST', 'foo.localhost', 'printer.local', 'db.internal', 'metadata.google.internal',
    'intranet', 'router.lan', 'nas.home.arpa', '',
  ]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.255.255', '100.63.255.255', '100.128.0.1', '192.169.0.1', '2606:4700::1111', 'example.com', 'cdn.example.co.uk']) {
    assert.equal(isPrivateHost(host), false, host);
  }
  // The URL parser turns these spellings into plain dotted addresses, so they reach the same check.
  for (const spelled of ['http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://[::ffff:7f00:1]/']) {
    assert.equal(subrequestBlockReason(spelled, config), 'private-address', spelled);
  }
});

test('requests made by the page: web content passes, private addresses and odd schemes are refused', () => {
  for (const ok of ['https://cdn.example.net/app.js', 'https://api.example.org/v1/items', 'wss://live.example.net/socket', 'data:text/plain;base64,aGk=', 'blob:https://example.com/1', 'about:blank']) {
    assert.equal(subrequestBlockReason(ok, config), null, ok);
  }
  assert.equal(subrequestBlockReason('http://169.254.169.254/latest/meta-data/', config), 'private-address');
  assert.equal(subrequestBlockReason('http://localhost:9222/json', config), 'private-address');
  assert.equal(subrequestBlockReason('http://10.1.2.3/admin', config), 'private-address');
  assert.equal(subrequestBlockReason('file:///etc/passwd', config), 'scheme');
  assert.equal(subrequestBlockReason('ftp://files.example.net/', config), 'scheme');
  assert.equal(subrequestBlockReason('chrome://settings', config), 'scheme');
  assert.equal(subrequestBlockReason('not a url', config), 'invalid-url');
});

test('a host you allow stays reachable even if it is a local name, so a development page can be rendered when you ask for it', () => {
  const dev = { allowedHosts: ['localhost'], allowAnyHost: false, blockResources: false };
  assert.equal(subrequestBlockReason('http://localhost:3000/app.js', dev), null);
  assert.equal(subrequestBlockReason('http://127.0.0.1:3000/app.js', dev), 'private-address');
});

test('resource blocking is off unless asked for, and then refuses trackers, fonts and images only', () => {
  assert.equal(subrequestBlockReason('https://www.google-analytics.com/collect', config), null);
  const blocking = { ...config, blockResources: true };
  assert.equal(subrequestBlockReason('https://www.google-analytics.com/collect', blocking), 'resource');
  assert.equal(subrequestBlockReason('https://cdn.example.net/logo.PNG', blocking), 'resource');
  assert.equal(subrequestBlockReason('https://cdn.example.net/app.js', blocking), null);
});

test('the plugin refuses a disallowed page with 403 before the browser is touched, and lets an allowed one through', () => {
  const plugin = createGuardPlugin(config);
  const sent = [];
  let nextCalls = 0;
  plugin.requestReceived({ prerender: { url: 'http://169.254.169.254/' } }, { send: code => sent.push(code) }, () => { nextCalls += 1; });
  assert.deepEqual(sent, [403]); assert.equal(nextCalls, 0);
  plugin.requestReceived({ prerender: { url: 'https://example.com/page' } }, { send: code => sent.push(code) }, () => { nextCalls += 1; });
  assert.deepEqual(sent, [403]); assert.equal(nextCalls, 1);
});

test('the plugin fails blocked requests and continues the others', async () => {
  const plugin = createGuardPlugin(config);
  const calls = [];
  let paused;
  const Fetch = {
    requestPaused: handler => { paused = handler; },
    enable: async () => { calls.push(['enable']); },
    failRequest: async arg => { calls.push(['fail', arg.requestId, arg.errorReason]); },
    continueRequest: async arg => { calls.push(['continue', arg.requestId]); },
  };
  await new Promise(resolve => plugin.tabCreated({ prerender: { tab: { Fetch } } }, {}, resolve));
  paused({ requestId: '1', request: { url: 'http://10.0.0.5/secret' } });
  paused({ requestId: '2', request: { url: 'https://example.com/app.js' } });
  assert.deepEqual(calls, [['enable'], ['fail', '1', 'BlockedByClient'], ['continue', '2']]);
});
