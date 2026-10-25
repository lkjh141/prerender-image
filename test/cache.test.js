'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenderCache, ENTRY_OVERHEAD_BYTES } = require('../lib/cache');

const page = (text, size = 100) => ({ status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(text.padEnd(size, ' ')) });
function clock(start = 1000) { const c = { at: start, now: () => c.at }; return c; }

test('a stored page is returned until its time is up, then it is gone', () => {
  const c = clock();
  const cache = createRenderCache({ ttlMs: 5000, maxBytes: 1e6, maxEntries: 10, now: c.now });
  assert.equal(cache.get('a'), null);
  cache.set('a', page('A'));
  assert.equal(cache.get('a').body.toString().trim(), 'A');
  c.at += 4999;
  assert.ok(cache.get('a'));
  c.at += 2;
  assert.equal(cache.get('a'), null, 'expired');
  assert.equal(cache.size, 0);
  assert.equal(cache.stats.bytes, 0, 'an expired entry gives its bytes back');
  assert.equal(cache.stats.hits, 2);
  assert.equal(cache.stats.expired, 1);
});

test('the least recently used entry goes first, by count', () => {
  const cache = createRenderCache({ ttlMs: 1e6, maxBytes: 1e6, maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) cache.set(k, page(k));
  cache.get('a'); // a is now the most recently used; b is the oldest
  cache.set('d', page('d'));
  assert.equal(cache.get('b'), null);
  for (const k of ['a', 'c', 'd']) assert.ok(cache.get(k), k);
  assert.equal(cache.stats.evictions, 1);
  assert.equal(cache.size, 3);
});

test('the byte limit holds, and one big page is not stored at all', () => {
  const each = 100 + 1 + ENTRY_OVERHEAD_BYTES;
  const cache = createRenderCache({ ttlMs: 1e6, maxBytes: each * 4, maxEntries: 1000 });
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) cache.set(k, page(k));
  assert.ok(cache.stats.bytes <= each * 4, `${cache.stats.bytes} > ${each * 4}`);
  assert.equal(cache.size, 4, 'the oldest two made room');
  assert.equal(cache.get('a'), null);
  assert.ok(cache.get('f'));
  assert.equal(cache.set('big', page('big', each * 4)), false, 'larger than a quarter of the limit');
  assert.equal(cache.get('big'), null);
  assert.equal(cache.stats.skippedLarge, 1);
  assert.equal(cache.size, 4, 'a refused big page evicted nothing');
});

test('storing the same key again replaces it and the byte count stays right', () => {
  const cache = createRenderCache({ ttlMs: 1e6, maxBytes: 1e6, maxEntries: 10 });
  cache.set('a', page('one', 100));
  const first = cache.stats.bytes;
  cache.set('a', page('two', 300));
  assert.equal(cache.size, 1);
  assert.equal(cache.stats.bytes, first + 200);
  assert.equal(cache.get('a').body.toString().trim(), 'two');
});

test('the sweep removes expired entries and keeps live ones; clear empties it', () => {
  const c = clock();
  const cache = createRenderCache({ ttlMs: 1000, maxBytes: 1e6, maxEntries: 10, now: c.now });
  cache.set('old', page('x'));
  c.at += 600;
  cache.set('new', page('y'));
  c.at += 600;
  cache.sweep();
  assert.equal(cache.size, 1);
  assert.ok(cache.get('new'));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.stats.bytes, 0);
});

test('the stored headers are a copy: changing the original afterwards does not change the cache', () => {
  const cache = createRenderCache({ ttlMs: 1e6, maxBytes: 1e6, maxEntries: 10 });
  const entry = page('x');
  cache.set('a', entry);
  entry.headers['content-type'] = 'text/evil';
  assert.equal(cache.get('a').headers['content-type'], 'text/html');
});
