'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createReleasePlugin, STRIP_AFTER_MS } = require('../lib/release');

function fakeRequest() {
  const tab = new EventEmitter();
  tab.closed = 0;
  tab.close = () => { tab.closed += 1; return Promise.resolve(); };
  tab.browser = { big: 'x'.repeat(10) };
  tab.Network = { enable() {} };
  tab.on('x', () => {});
  const response = new EventEmitter();
  const req = { res: response, prerender: { reqId: 'r1', renderId: 'd1', url: 'http://a/', tab, content: '<html>answer</html>', statusCode: 200, headers: { a: 'b' }, pageLoadInfo: { entries: { 1: {} } }, requests: { 1: 'u' }, errors: ['e'] } };
  return { req, tab, response };
}
const run = req => new Promise(resolve => createReleasePlugin().beforeSend(req, {}, resolve));

test('the answer is untouched, the request log and the tab connection are released at once', async () => {
  const { req, tab } = fakeRequest();
  await run(req);
  assert.equal(req.prerender.content, '<html>answer</html>');
  assert.equal(req.prerender.statusCode, 200);
  assert.deepEqual(req.prerender.headers, { a: 'b', 'x-prerender-complete': '0' }, 'the fake request has a browser error, so it is marked incomplete');
  assert.equal(req.prerender.pageLoadInfo, null);
  assert.equal(req.prerender.requests, null);
  assert.equal(tab.listenerCount('x'), 0, 'handlers removed');
  assert.equal(tab.closed, 1, 'connection closed');
  assert.ok(tab.browser, 'the browser handle is kept for a moment: Prerender\'s own clean-up still needs it');
});

test('after the response closes, the request state is replaced by a stub that keeps what the 60 s timer reads', async () => {
  const { req, response } = fakeRequest();
  await run(req);
  response.emit('close');
  assert.deepEqual(req.prerender, { reqId: 'r1', renderId: 'd1', url: 'http://a/', responseSent: true });
});

test('the tab object is emptied later', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { req, tab } = fakeRequest();
  await run(req);
  assert.ok(Object.keys(tab).length > 0);
  t.mock.timers.tick(STRIP_AFTER_MS + 1);
  assert.deepEqual(Object.keys(tab), [], 'nothing of size is left on the tab');
});

test('releasing never fails the request, whatever the state is', async () => {
  for (const req of [{ prerender: undefined }, { prerender: { tab: null } }, { res: null, prerender: { tab: { close: () => { throw new Error('boom'); } } } }, { res: { once() { throw new Error('boom'); } }, prerender: {} }]) {
    await run(req); // resolves: next() was called
  }
});

const { markCompleteness } = require('../lib/release');

test('a render is marked complete only when it finished cleanly', () => {
  const mark = state => { const req = { prerender: { headers: { a: 'b' }, ...state } }; markCompleteness(req); return req.prerender.headers; };
  assert.equal(mark({})['x-prerender-complete'], '1');
  assert.equal(mark({ errors: [] })['x-prerender-complete'], '1');
  assert.equal(mark({ timedout: true })['x-prerender-complete'], '0', 'a page-load timeout');
  assert.equal(mark({ dirtyRender: true })['x-prerender-complete'], '0', 'a 5xx answer to one of the page\'s own requests');
  assert.equal(mark({ errors: ['x'] })['x-prerender-complete'], '0', 'a browser error');
  assert.equal(mark({})['a'], 'b', 'the page\'s own headers are kept');
  const bare = { prerender: {} }; markCompleteness(bare);
  assert.equal(bare.prerender.headers['x-prerender-complete'], '1', 'no headers object yet');
  markCompleteness({}); // no state at all: must not throw
});

test('the release plugin marks the render before it hands the memory back', async () => {
  const { req } = fakeRequest();
  req.prerender.errors = [];
  await run(req);
  assert.equal(req.prerender.headers['x-prerender-complete'], '1');
});
