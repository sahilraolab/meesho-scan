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
});
