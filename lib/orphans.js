'use strict';

// When a page navigates itself (a reload, or a script that replaces the location), Chromium cancels the requests of the old
// document. It normally reports each one as failed. Now and then it reports nothing for a request of the old document: seen with
// a script, a font, API calls, and above all the analytics beacon that an error-reporting library sends while the page unloads (a
// request that survives the navigation by design). Prerender counts a page as finished only when no request is in flight, so
// that one request keeps the count above zero and the render ends at the page-load timeout, with the right content, ten seconds late.
//
// This plugin gives the requests of the old document a short time to report back after the page has started a new document.
// Those still unreported are written off: they belong to a document that no longer exists and cannot change the page that is
// returned. A request counts as "old" when it was made by the main frame under an earlier document (its loader id differs from
// the current one), so requests of the new document, of other frames and the new document's own request are never touched.

function createOrphanPlugin({ settleMs, log }) {
  return {
    tabCreated: (req, res, next) => {
      try {
        const tab = req.prerender.tab;
        let mainFrameId = null;
        let currentDocument = null;
        let currentLoader = null;
        const made = new Map(); // requestId -> { frameId, loaderId }
        tab.Network.requestWillBeSent(params => {
          const state = tab.prerender;
          if (!state) return;
          if (params.requestId && params.frameId && params.loaderId && !made.has(params.requestId)) {
            made.set(params.requestId, { frameId: params.frameId, loaderId: params.loaderId });
          }
          if (params.type !== 'Document' || params.redirectResponse) return;
          if (mainFrameId === null) { // the first document request is the page that was asked for
            if (params.requestId !== state.initialRequestId) return;
            mainFrameId = params.frameId;
            currentDocument = params.requestId;
            currentLoader = params.loaderId;
            return;
          }
          if (params.frameId !== mainFrameId || params.requestId === currentDocument) return;
          currentDocument = params.requestId;
          currentLoader = params.loaderId;
          const timer = setTimeout(() => {
            try {
              const requests = tab.prerender && tab.prerender.requests;
              if (!requests) return;
              let count = 0;
              for (const id of Object.keys(requests)) {
                const meta = made.get(id);
                if (!meta || meta.frameId !== mainFrameId || meta.loaderId === currentLoader || id === currentDocument) continue;
                delete requests[id];
                tab.prerender.numRequestsInFlight -= 1;
                count += 1;
              }
              if (count > 0) {
                tab.prerender.lastRequestReceivedAt = Date.now();
                log(`wrote off ${count} request(s) of the previous document that never reported back after the page navigated itself`);
              }
            } catch { /* the tab is already gone */ }
          }, settleMs);
          timer.unref();
        });
      } catch { /* never block a render because of this */ }
      next();
    },
  };
}

module.exports = { createOrphanPlugin };
