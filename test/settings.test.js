'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSettings } = require('../lib/settings');

test('defaults are sane and every number is within its range', () => {
  const s = loadSettings({});
  assert.equal(s.MAX_CONCURRENCY, 4);
  assert.equal(s.MAX_QUEUE, 32);
  assert.ok(s.REQUEST_TIMEOUT_MS > s.PAGE_LOAD_TIMEOUT_MS);
  assert.ok(s.TAB_MAX_AGE_MS > s.REQUEST_TIMEOUT_MS);
  assert.deepEqual(s.EGRESS_ALLOWED_PORTS, [80, 443]);
  assert.equal(s.METRICS_ENABLED, false);
});

test('a typo is an error, never "no limit"', () => {
  for (const bad of [{ MAX_CONCURRENCY: '0' }, { MAX_CONCURRENCY: '-1' }, { MAX_CONCURRENCY: '4.5' }, { MAX_CONCURRENCY: 'many' }, { MAX_CONCURRENCY: '1e3' },
    { MAX_QUEUE: '99999' }, { REQUEST_TIMEOUT_MS: '10' }, { MAX_RESPONSE_BYTES: '0' }, { EGRESS_ALLOWED_PORTS: '80,abc' }, { EGRESS_ALLOWED_PORTS: '0' }, { EGRESS_ALLOWED_PORTS: '70000' }]) {
    assert.throws(() => loadSettings(bad), Error, JSON.stringify(bad));
  }
});

test('the timeouts must nest: tab age > request > page load', () => {
  assert.throws(() => loadSettings({ REQUEST_TIMEOUT_MS: '10000', PAGE_LOAD_TIMEOUT_MS: '20000' }), /REQUEST_TIMEOUT_MS/);
  assert.throws(() => loadSettings({ TAB_MAX_AGE_MS: '20000' }), /TAB_MAX_AGE_MS/);
  assert.doesNotThrow(() => loadSettings({ PAGE_LOAD_TIMEOUT_MS: '10000', REQUEST_TIMEOUT_MS: '15000', TAB_MAX_AGE_MS: '20000' }));
});

test('values are taken from the environment', () => {
  const s = loadSettings({ MAX_CONCURRENCY: '8', METRICS_ENABLED: 'true', EGRESS_ALLOWED_PORTS: '80, 443 ,8443' });
  assert.equal(s.MAX_CONCURRENCY, 8);
  assert.equal(s.METRICS_ENABLED, true);
  assert.deepEqual(s.EGRESS_ALLOWED_PORTS, [80, 443, 8443]);
});

test('diagnostics are off by default and the page filter is on; both can be switched', () => {
  const s = loadSettings({});
  assert.equal(s.DIAGNOSTICS, false);
  assert.equal(s.PAGE_FILTER, true);
  assert.equal(loadSettings({ DIAGNOSTICS: 'true' }).DIAGNOSTICS, true);
  assert.equal(loadSettings({ PAGE_FILTER: 'false' }).PAGE_FILTER, false);
  assert.equal(loadSettings({ PAGE_FILTER: 'FALSE' }).PAGE_FILTER, false);
  assert.equal(loadSettings({ PAGE_FILTER: 'nope' }).PAGE_FILTER, true, 'only the word false switches the filter off');
});
