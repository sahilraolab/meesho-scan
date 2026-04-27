// Content script — runs on supplier.meesho.com
// Connects to local WS server, receives scan events, auto-fills the Returns search.

(function () {
  'use strict';

  let ws        = null;
  let token     = null;
  let serverUrl = null;
  let reconnectTimer = null;
  let indicator = null;

  // ── Load config & connect ────────────────────────────────────────────────────

  function loadAndConnect() {
    chrome.storage.local.get(['serverUrl', 'token', 'email'], (data) => {
      serverUrl = (data.serverUrl || '').replace(/\/$/, '');
      token     = data.token || null;
      if (token && serverUrl) {
        connect();
      }
    });
  }

  // ── WebSocket ────────────────────────────────────────────────────────────────

  function wsUrl() {
    return serverUrl.replace(/^http/, 'ws');
  }

  function connect() {
    clearTimeout(reconnectTimer);
    if (ws) { try { ws.close(); } catch {} }

    ws = new WebSocket(wsUrl());

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token, role: 'extension' }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'auth_ok':
          setIndicator('connected');
          break;
        case 'auth_error':
          setIndicator('error');
          break;
        case 'peer_connected':
          if (msg.role === 'mobile') showNotification('📱 Mobile scanner connected');
          break;
        case 'peer_disconnected':
          if (msg.role === 'mobile') showNotification('📱 Mobile scanner disconnected', true);
          break;
        case 'session_replaced':
          setIndicator('error');
          ws.close();
          break;
        case 'scan':
          handleScan(msg.awb, msg.ts);
          break;
        case 'claim':
          handleClaim(msg);
          break;
      }
    };

    ws.onclose = () => {
      setIndicator('disconnected');
      reconnectTimer = setTimeout(loadAndConnect, 4000);
    };

    ws.onerror = () => {
      setIndicator('disconnected');
    };
  }

  // ── Scan handling ─────────────────────────────────────────────────────────────

  async function handleScan(awb, ts) {
    // Log to local storage
    chrome.storage.local.get(['scanLog'], (data) => {
      const log = data.scanLog || [];
      log.unshift({ awb, ts, receivedAt: Date.now(), url: location.href });
      if (log.length > 1000) log.splice(1000);
      chrome.storage.local.set({ scanLog: log });
    });

    showNotification(`📦 Scanning: ${awb}`);

    // Try to navigate to returns page and search
    const isReturns = /\/returns/i.test(location.pathname);
    if (!isReturns) {
      // Navigate to returns page; search will fire once content reloads
      chrome.storage.local.set({ pendingAWB: awb }, () => {
        window.location.href = 'https://supplier.meesho.com/returns';
      });
      return;
    }

    await searchAWB(awb);
  }

  // ── Search AWB on Returns page ────────────────────────────────────────────────

  async function searchAWB(awb) {
    showNotification(`🔍 Searching ${awb}…`);

    try {
      // Wait for the exact Meesho Returns search input
      const input = await waitForElement(
        'input[placeholder="Search by Order ID, SKU or AWB Number"]',
        8000
      );
      if (!input) {
        showNotification(`❌ Search input not found`, true);
        return;
      }

      input.focus();

      // Use React's internal value setter so onChange fires correctly
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, awb);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));

      await sleep(300);

      // Press Enter to trigger the search
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

      showNotification(`✅ Searched: ${awb}`);
    } catch (err) {
      console.error('[MeeshoScan] searchAWB error:', err);
      showNotification(`❌ Search failed: ${err.message}`, true);
    }
  }

  // ── Claim handling ────────────────────────────────────────────────────────────

  function handleClaim(msg) {
    showNotification(`🎫 Claim for ${msg.awb || '?'} received — click "Fill Form" in the extension popup`);
  }

  async function fillClaimById(claimId) {
    // Try stored claim object first (set by popup when tab needs reload)
    const data = await chromeGet(['pendingFillClaim']);
    if (data.pendingFillClaim && data.pendingFillClaim.claimId === claimId) {
      chrome.storage.local.remove('pendingFillClaim');
      await fillClaimForm(data.pendingFillClaim);
      return;
    }
    showNotification('Claim data not found — please try Fill Form again', true);
  }

  async function fillClaimForm(claim) {
    const { claimId, awb, subOrderNum, packetId, files } = claim;
    showNotification('🎫 Filling claim form…');

    try {
      const { token, serverUrl } = await chromeGet(['token', 'serverUrl']);
      const srv = (serverUrl || '').replace(/\/$/, '');

      // ── Sub Order Number ─────────────────────────────────────────────────────
      if (subOrderNum) {
        const inp = await waitForElement('input[placeholder="Sub Order Number"]', 5000);
        if (inp) fillReactInput(inp, subOrderNum);
        await sleep(200);
      }

      // ── Packet ID ────────────────────────────────────────────────────────────
      if (packetId) {
        const inp = document.querySelector('input[placeholder="Packet ID"]');
        if (inp) fillReactInput(inp, packetId);
        await sleep(200);
      }

      // ── AWB — MUI combobox (role="combobox" > input[aria-autocomplete="list"])
      if (awb) {
        const awbInput = document.querySelector('[role="combobox"] input[aria-autocomplete="list"]');
        if (awbInput) {
          awbInput.focus();
          fillReactInput(awbInput, awb);
          await sleep(800);
          // Open the dropdown
          const openBtn = document.querySelector('[role="combobox"] button[aria-label="Open menu"]');
          if (openBtn) openBtn.click();
          await sleep(600);
          // Pick first suggestion
          const option = document.querySelector('[role="option"]');
          if (option) option.click();
          await sleep(300);
        }
      }

      // ── File uploads — exact id-prefix selectors from Meesho's form HTML ────
      if (srv && token) {
        const fileMap = [
          { field: 'barcode_image',   selector: 'input[id^="barcode_image_link"]' },
          { field: 'product_image',   selector: 'input[id^="product_image_link"]' },
          { field: 'reverse_waybill', selector: 'input[id^="product_reverse_way_bill_link"]' },
          { field: 'unpacking_video', selector: 'input[id^="product_openingvideo_link"]' },
        ];
        for (const { field, selector } of fileMap) {
          if (!files?.[field]) continue;
          showNotification(`📎 Uploading ${field.replace(/_/g, ' ')}…`);
          const inp = await waitForElement(selector, 6000);
          if (!inp) {
            showNotification(`⚠️ Upload input not found: ${field}`, true);
            console.warn('[MeeshoScan] file input not found:', selector);
            continue;
          }
          const ok = await injectFile(inp, `${srv}/api/claim/${claimId}/${field}`, token, field);
          if (ok) showNotification(`✅ ${field.replace(/_/g, ' ')} uploaded`);
          await sleep(800);
        }
      }

      showNotification('✅ Form filled — add description and submit');
    } catch (err) {
      console.error('[MeeshoScan] fillClaimForm:', err);
      showNotification(`❌ Fill error: ${err.message}`, true);
    }
  }

  function fillReactInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function injectFile(input, url, token, field) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        showNotification(`❌ Fetch failed: ${field} (${res.status})`, true);
        console.warn('[MeeshoScan] file fetch failed:', res.status, url);
        return false;
      }
      const blob = await res.blob();

      const mimeToExt = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
        'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
      };
      const ext = mimeToExt[blob.type] || blob.type.split('/')[1] || 'bin';
      const fieldName = url.split('/').pop();
      const file = new File([blob], `${fieldName}.${ext}`, { type: blob.type });
      const dt = new DataTransfer();
      dt.items.add(file);

      // Set files on the input instance before dispatching events
      Object.defineProperty(input, 'files', { value: dt.files, writable: true, configurable: true });

      // Path 1: native DOM change event — React's root listener and any direct listeners pick this up
      input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      await sleep(100);

      // Path 2: call React fiber's onChange prop directly (handles components that use refs instead of events)
      const fiberKey = Object.keys(input).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (fiberKey) {
        const onChange = input[fiberKey]?.memoizedProps?.onChange;
        if (typeof onChange === 'function') {
          try {
            onChange({ target: input, currentTarget: input, nativeEvent: { target: input }, preventDefault() {}, stopPropagation() {} });
          } catch {}
        }
      }

      // Path 3: simulate a label click with files already injected — triggers any click-based upload handlers
      const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
      if (label) {
        // Override click temporarily so it doesn't open the file dialog
        const origClick = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function () {};
        label.click();
        HTMLInputElement.prototype.click = origClick;
      }

      return true;
    } catch (err) {
      showNotification(`❌ Upload error: ${field}: ${err.message}`, true);
      console.warn('[MeeshoScan] injectFile error:', err);
      return false;
    }
  }

  function chromeGet(keys) {
    return new Promise(r => chrome.storage.local.get(keys, r));
  }

  // ── Pending fill claim after tab reload ───────────────────────────────────────

  function checkPendingFillClaim() {
    chrome.storage.local.get(['pendingFillClaimId', 'pendingFillClaim'], (data) => {
      if (!data.pendingFillClaimId) return;
      const claim = data.pendingFillClaim || null;
      chrome.storage.local.remove(['pendingFillClaimId', 'pendingFillClaim'], async () => {
        await sleep(2000);
        if (claim) await fillClaimForm(claim);
        else await fillClaimById(data.pendingFillClaimId);
      });
    });
  }

  // ── Check for pending AWB after navigation ────────────────────────────────────

  function checkPendingAWB() {
    chrome.storage.local.get(['pendingAWB'], (data) => {
      if (data.pendingAWB) {
        const awb = data.pendingAWB;
        chrome.storage.local.remove('pendingAWB', async () => {
          // Give the page a moment to render
          await sleep(2000);
          if (/\/returns/i.test(location.pathname)) {
            await searchAWB(awb);
          }
        });
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      const el = document.querySelector(selector);
      if (el) { resolve(el); return; }

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) { observer.disconnect(); resolve(found); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
    });
  }

  // ── On-page indicator ────────────────────────────────────────────────────────

  function createIndicator() {
    indicator = document.createElement('div');
    indicator.id = '__meesho_scan_indicator__';
    Object.assign(indicator.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      zIndex: '2147483647',
      background: '#fff',
      border: '1.5px solid #e5e5e5',
      borderRadius: '24px',
      padding: '7px 14px',
      fontSize: '12px',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '600',
      color: '#666',
      boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
      display: 'flex',
      alignItems: 'center',
      gap: '7px',
      transition: 'opacity 0.3s',
      cursor: 'default',
      userSelect: 'none',
    });
    document.body.appendChild(indicator);
  }

  function setIndicator(state) {
    if (!indicator) createIndicator();
    const states = {
      connected:    { dot: '#16a34a', text: 'Meesho Scan: Connected' },
      disconnected: { dot: '#d97706', text: 'Meesho Scan: Disconnected' },
      error:        { dot: '#dc2626', text: 'Meesho Scan: Auth Error' },
    };
    const s = states[state] || states.disconnected;
    indicator.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${s.dot};display:inline-block;flex-shrink:0;"></span>
      ${s.text}
    `;
  }

  // ── Notification banner ───────────────────────────────────────────────────────

  let notifTimer = null;
  let notifEl = null;

  function showNotification(msg, isError = false) {
    if (!notifEl) {
      notifEl = document.createElement('div');
      notifEl.id = '__meesho_scan_notif__';
      Object.assign(notifEl.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '2147483647',
        background: '#1a1a1a',
        color: '#fff',
        borderRadius: '10px',
        padding: '12px 18px',
        fontSize: '14px',
        fontFamily: 'system-ui, sans-serif',
        fontWeight: '500',
        boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        transition: 'opacity 0.3s',
        maxWidth: '320px',
        lineHeight: '1.4',
      });
      document.body.appendChild(notifEl);
    }
    notifEl.textContent = msg;
    notifEl.style.background = isError ? '#dc2626' : '#1a1a1a';
    notifEl.style.opacity = '1';
    clearTimeout(notifTimer);
    notifTimer = setTimeout(() => { notifEl.style.opacity = '0'; }, 3000);
  }

  // ── Listen for messages from background/popup ─────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'reconnect')    loadAndConnect();
    if (msg.type === 'manual_scan')  handleScan(msg.awb, Date.now());
    if (msg.type === 'fill_claim') {
      if (msg.claim) fillClaimForm(msg.claim);
      else fillClaimById(msg.claimId);
      sendResponse({ ok: true });
    }
  });

  // ── Storage change listener (token/server updated from popup) ─────────────────

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.token || changes.serverUrl) {
      loadAndConnect();
    }
  });

  // ── Init ──────────────────────────────────────────────────────────────────────

  // Delay slightly to let page JS settle
  setTimeout(() => {
    checkPendingAWB();
    checkPendingFillClaim();
    loadAndConnect();
  }, 1500);

})();
