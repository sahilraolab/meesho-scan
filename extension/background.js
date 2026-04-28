'use strict';

// Forward popup → content script
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'popup_to_content') {
    chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
      for (const tab of tabs)
        chrome.tabs.sendMessage(tab.id, msg.payload).catch(() => {});
      sendResponse({ sent: tabs.length });
    });
    return true;
  }

  // Proxy authenticated file fetches on behalf of content.js
  // content scripts run inside supplier.meesho.com's CSP — background workers do not
  if (msg.type === 'fetch_file') {
    const { url, token } = msg;
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({ ok: false, status: res.status });
          return;
        }
        const ab = await res.arrayBuffer();
        const bytes = Array.from(new Uint8Array(ab));
        const mime = res.headers.get('content-type') || 'application/octet-stream';
        sendResponse({ ok: true, mime, bytes });
      })
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep channel open for async sendResponse
  }
});
