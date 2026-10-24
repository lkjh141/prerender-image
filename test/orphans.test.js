'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrphanPlugin } = require('../lib/orphans');

// A tab that counts requests the way Prerender does: +1 on requestWillBeSent, -1 when one is reported finished or failed.
function fakeTab() {
  const handlers = [];
  const tab = {
    Network: { requestWillBeSent: handler => handlers.push(handler) },
    prerender: { requests: {}, numRequestsInFlight: 0, initialRequestId: null, lastRequestReceivedAt: 0 },
  };
  tab.send = params => {
    const state = tab.prerender;
    state.numRequestsInFlight += 1;
    state.requests[params.requestId] = params.url;
    if (!state.initialRequestId) state.initialRequestId = params.requestId;
    for (const handler of handlers) handler(params);
  };
  tab.finish = requestId => { delete tab.prerender.requests[requestId]; tab.prerender.numRequestsInFlight -= 1; };
  return tab;
}
// A document's loader id is its own request id; a script made by a document carries that document's loader id.
const document = (requestId, extra = {}) => ({ requestId, type: 'Document', frameId: 'main', loaderId: requestId, url: 'https://x/', ...extra });
const script = (requestId, loaderId = 'd1', frameId = 'main') => ({ requestId, type: 'Script', frameId, loaderId, url: `https://x/${requestId}.js` });

function setup(t, settleMs = 750) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const logged = [];
  const tab = fakeTab();
  const plugin = createOrphanPlugin({ settleMs, log: line => logged.push(line) });
  let called = 0;
  plugin.tabCreated({ prerender: { tab } }, {}, () => { called += 1; });
  assert.equal(called, 1, 'the plugin always lets the render go on');
  return { tab, logged };
}

test('a request of the old document that never reports back is written off after the page navigates itself', t => {
  const { tab, logged } = setup(t);
  tab.send(document('d1'));
  tab.send(script('s1'));
  tab.finish('d1');
  tab.send(script('orphan')); // started just before the navigation; Chromium never reports it
  tab.send(document('d2')); // the page reloads itself
  tab.finish('d2');
  tab.finish('s1');
  assert.equal(tab.prerender.numRequestsInFlight, 1, 'one request is left and the render would wait for it');
  t.mock.timers.tick(749);
  assert.equal(tab.prerender.numRequestsInFlight, 1, 'the old requests still have their time to report back');
  t.mock.timers.tick(2);
  assert.equal(tab.prerender.numRequestsInFlight, 0);
  assert.deepEqual(tab.prerender.requests, {});
  assert.ok(tab.prerender.lastRequestReceivedAt > 0, 'the quiet period starts from the write-off');
  assert.equal(logged.length, 1);
});

test('old requests that do report back are left alone and nothing is counted twice', t => {
  const { tab, logged } = setup(t);
  tab.send(document('d1'));
  tab.send(script('s1'));
  tab.send(document('d2'));
  tab.finish('s1'); // reported failed by the browser, as it normally is
  tab.finish('d1');
  t.mock.timers.tick(1000);
  assert.equal(tab.prerender.numRequestsInFlight, 1, 'only the new document is in flight');
  assert.deepEqual(Object.keys(tab.prerender.requests), ['d2']);
  assert.equal(logged.length, 0);
});

test('requests the new document starts are never written off', t => {
  const { tab } = setup(t);
  tab.send(document('d1'));
  tab.send(script('old'));
  tab.send(document('d2'));
  tab.send(script('new', 'd2')); // started after the navigation by the new document
  t.mock.timers.tick(1000);
  assert.deepEqual(Object.keys(tab.prerender.requests).sort(), ['d2', 'new']);
  assert.equal(tab.prerender.numRequestsInFlight, 2);
});

test('a request the old document makes while it unloads, after the new document was requested, is written off too', t => {
  const { tab } = setup(t);
  tab.send(document('d1'));
  tab.send(document('d2')); // the page reloads itself
  tab.send(script('beacon')); // an error reporter flushes while the old document unloads
  tab.finish('d1');
  tab.finish('d2');
  t.mock.timers.tick(751);
  assert.equal(tab.prerender.numRequestsInFlight, 0);
});

test('requests of another frame are never written off', t => {
  const { tab } = setup(t);
  tab.send(document('d1'));
  tab.send(script('inframe', 'f1', 'sub'));
  tab.send(document('d2'));
  t.mock.timers.tick(5000);
  assert.ok(tab.prerender.requests.inframe);
});

test('a redirect of the first page, a frame inside the page and the same document are not navigations', t => {
  const { tab } = setup(t);
  tab.send(document('d1'));
  tab.send(script('s1'));
  tab.send(document('d1', { redirectResponse: { status: 301 } })); // redirect: same request id, has a redirect response
  tab.send(document('frame1', { frameId: 'sub' })); // an iframe
  t.mock.timers.tick(5000);
  assert.ok(tab.prerender.requests.s1, 'nothing was written off');
});

test('a tab that is already released when the time is up is left alone', t => {
  const { tab } = setup(t);
  tab.send(document('d1'));
  tab.send(script('old'));
  tab.send(document('d2'));
  tab.prerender.requests = null; // the release plugin has run
  t.mock.timers.tick(1000); // must not throw
});
