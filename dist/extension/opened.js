"use strict";
(() => {
  // extension/src/opened.ts
  var OPEN_PATH = /^\/open\/([0-9a-f]{32})$/;
  markPage();
  var code = OPEN_PATH.exec(location.pathname)?.[1];
  if (code !== void 0 && navigationType() !== "back_forward") void tell(code);
  function markPage() {
    if (document.documentElement) {
      document.documentElement.setAttribute("data-clicknote", "");
      return;
    }
    const watching = new MutationObserver(() => {
      if (!document.documentElement) return;
      document.documentElement.setAttribute("data-clicknote", "");
      watching.disconnect();
    });
    watching.observe(document, { childList: true });
  }
  function navigationType() {
    const [entry] = performance.getEntriesByType("navigation");
    return entry?.type;
  }
  async function tell(code2) {
    try {
      await chrome.runtime.sendMessage({ type: "opened", code: code2 });
    } catch {
    }
    document.dispatchEvent(new Event("clicknote:linked"));
  }
})();
