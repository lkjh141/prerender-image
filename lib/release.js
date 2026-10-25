'use strict';

// Prerender keeps the state of every finished request alive for a long time, and that is what makes the stock image run out of
// memory under steady load. Measured with plain Prerender 5.21.6 and a forced garbage collection (so only memory that is really
// still referenced counts): about 4.5 MB per rendered page stays reachable, and it is released only when two timers that are never
// cancelled have fired: a 60 s timer in onRequest that closes over the request, and the page-load timeout (20 s by default) that
// closes over the browser tab. At a steady 3 pages a second that is ~900 MB of heap; with the 384 MB heap cap of this image the
// process ran out of memory after about 100 pages. After the load stopped, the heap fell back to 9 MB, so it is a delay and not a
// leak, but the delay is proportional to the request rate and a flood can use it up.
//
// This plugin hands the memory back as soon as the answer has been built:
//   1. at once, drop the per-request network log, the page's event handlers and the tab's connection to the browser;
//   2. a few seconds later (Prerender's own tab clean-up still needs `tab.browser` for a moment), empty the tab object itself, so
//      the timers that still hold it hold nothing of size.
// The answer that is being sent is not touched: it is built from req.prerender.content, headers and statusCode.

const STRIP_AFTER_MS = 8000;

// The front server may keep an answer only when the render finished cleanly: no page-load timeout, no 5xx answer to one of the
// page's own requests, no browser error. A page that timed out may be missing content that would have arrived a moment later.
// The marker travels as an internal response header; the front server does not pass it on.
function markCompleteness(req) {
  const state = req.prerender;
  if (!state) return;
  const clean = !state.timedout && !state.dirtyRender && !(Array.isArray(state.errors) && state.errors.length > 0);
  state.headers = { ...(state.headers || {}), 'x-prerender-complete': clean ? '1' : '0' };
}

function release(req) {
  const prerender = req.prerender;
  if (!prerender) return;
  const tab = prerender.tab;
  prerender.pageLoadInfo = null; // the full request log, used only for HAR files
  prerender.requests = null;
  prerender.errors = [];
  if (!tab) return;
  try { if (typeof tab.removeAllListeners === 'function') tab.removeAllListeners(); } catch { /* nothing to remove */ }
  try {
    const closing = typeof tab.close === 'function' ? tab.close() : null;
    if (closing && typeof closing.catch === 'function') closing.catch(() => {});
  } catch { /* already closed */ }
  const strip = setTimeout(() => {
    try { for (const key of Object.keys(tab)) delete tab[key]; } catch { /* frozen or already empty */ }
  }, STRIP_AFTER_MS);
  strip.unref();
}

function createReleasePlugin() {
  return {
    beforeSend: (req, res, next) => {
      try {
        const response = req.res;
        const prerender = req.prerender;
        markCompleteness(req);
        release(req);
        // Once the answer is on its way, also drop the page content and replace the request's state by a stub that keeps only what
        // the 60 s timer in onRequest reads.
        if (response && prerender) {
          response.once('close', () => {
            req.prerender = { reqId: prerender.reqId, renderId: prerender.renderId, url: prerender.url, responseSent: true };
          });
        }
      } catch { /* releasing is best effort and must never change the answer */ }
      next();
    },
  };
}

module.exports = { createReleasePlugin, release, markCompleteness, STRIP_AFTER_MS };
