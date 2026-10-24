'use strict';

// When a page navigates itself (a reload, or a script that replaces the location), Chromium cancels the requests of the old
// document. It normally reports each one as failed. Now and then it reports nothing for a request that was started in the last
// moments before the navigation (seen with a script, a font, an API call and an analytics beacon, a different one each time).
// Prerender counts a page as finished only when no request is in flight, so that one request keeps the count above zero and the
// render ends at the page-load timeout, with the right content and ten seconds late.
//
// This plugin gives the old document's requests a short time to report back after the page has started a new document. Those
// still unreported are written off: they belong to a document that no longer exists and cannot change the page that is returned.

function createOrphanPlugin({ settleMs, log }) {
  return {
    tabCreated: (req, res, next) => {
      try {
        const tab = req.prerender.tab;
        let mainFrameId = null;
        let currentDocument = null;
        tab.Network.requestWillBeSent(params => {
          if (params.type !== 'Document' || params.redirectResponse) return;
          const state = tab.prerender;
          if (!state) return;
          if (mainFrameId === null) { // the first document request is the page that was asked for
            if (params.requestId !== state.initialRequestId) return;
            mainFrameId = params.frameId;
            currentDocument = params.requestId;
            return;
          }
          if (params.frameId !== mainFrameId || params.requestId === currentDocument) return;
          currentDocument = params.requestId;
          const old = Object.keys(state.requests || {}).filter(id => id !== params.requestId);
          if (old.length === 0) return;
          const timer = setTimeout(() => {
            try {
              const requests = tab.prerender && tab.prerender.requests;
              if (!requests) return;
              const stuck = old.filter(id => Object.prototype.hasOwnProperty.call(requests, id));
              for (const id of stuck) {
                delete requests[id];
                tab.prerender.numRequestsInFlight -= 1;
              }
              if (stuck.length > 0) {
                tab.prerender.lastRequestReceivedAt = Date.now();
                log(`wrote off ${stuck.length} request(s) of the previous document that never reported back after the page navigated itself`);
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
