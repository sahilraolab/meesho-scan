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

      // ── File uploads ─────────────────────────────────────────────────────────
      // Each entry has a primary selector and fallback selectors in case Meesho
      // changes the input IDs across page variants or A/B tests.
      if (srv && token) {
        const fileMap = [
          {
            field: 'barcode_image',
            selectors: [
              'input[id^="barcode_image_link"]',
              'input[id*="barcode"]',
              'input[accept*="image"][id*="barcode"]',
            ],
          },
          {
            field: 'product_image',
            selectors: [
              'input[id^="product_image_link"]',
              'input[id*="product_image"]',
              'input[accept*="image"][id*="product"]',
            ],
          },
          {
            field: 'reverse_waybill',
            selectors: [
              'input[id^="product_reverse_way_bill_link"]',
              'input[id*="reverse_way_bill"]',
              'input[id*="waybill"]',
            ],
          },
          {
            field: 'unpacking_video',
            selectors: [
              'input[id^="product_openingvideo_link"]',
              'input[id*="openingvideo"]',
              'input[id*="unpacking"]',
              'input[accept*="video"]',
            ],
          },
        ];

        for (const { field, selectors } of fileMap) {
          if (!files?.[field]) continue;
          showNotification(`📎 Uploading ${field.replace(/_/g, ' ')}…`);

          // Try each selector in order until we find the input
          let inp = null;
          for (const selector of selectors) {
            inp = await waitForElement(selector, field === selectors[0] ? 8000 : 1000);
            if (inp) { console.log(`[MeeshoScan] found ${field} via: ${selector}`); break; }
          }

          if (!inp) {
            showNotification(`⚠️ Upload input not found: ${field}`, true);
            console.warn('[MeeshoScan] file input not found for:', field, '— tried:', selectors);
            continue;
          }

          const ok = await injectFile(inp, `${srv}/api/claim/${claimId}/${field}`, token, field);
          if (ok) showNotification(`✅ ${field.replace(/_/g, ' ')} uploaded`);
          else showNotification(`⚠️ ${field.replace(/_/g, ' ')} may not have been accepted — check form`, true);
          await sleep(1000);
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

  // Fetch file bytes via background worker (bypasses page CSP)
  async function fetchFileViaBackground(url, token) {
    const resp = await new Promise((resolve) =>
      chrome.runtime.sendMessage({ type: 'fetch_file', url, token }, resolve)
    );
    if (!resp || !resp.ok) throw new Error(resp?.error || `HTTP ${resp?.status}`);
    const mimeToExt = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    };
    const mime = resp.mime || 'application/octet-stream';
    const ext  = mimeToExt[mime] || mime.split('/')[1] || 'bin';
    const blob = new Blob([new Uint8Array(resp.bytes)], { type: mime });
    const name = url.split('/').pop();
    return new File([blob], `${name}.${ext}`, { type: mime });
  }

  async function injectFile(input, url, token, field) {
    try {
      const file = await fetchFileViaBackground(url, token);
      console.log(`[MeeshoScan] fetched ${field}: ${file.name} ${file.size}b ${file.type}`);

      // ── Strategy: intercept the input's click so the file picker never opens,
      // then inject our file and fire React's change pipeline ──────────────────

      const dt = new DataTransfer();
      dt.items.add(file);

      // Step 1 — neutralise .click() so when Meesho's button triggers the
      // hidden file input, no OS dialog appears
      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function() {
        if (this === input) return; // block only our target input
        origClick.call(this);
      };

      // Step 2 — set up a one-shot 'click' interceptor on the input itself
      // to inject files the moment the input is "activated"
      const clickInterceptor = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        triggerReactFileChange(input, dt.files);
      };
      input.addEventListener('click', clickInterceptor, { capture: true, once: true });

      // Step 3 — directly trigger without waiting for a user click
      await triggerReactFileChange(input, dt.files);

      // Restore .click()
      HTMLInputElement.prototype.click = origClick;
      input.removeEventListener('click', clickInterceptor, { capture: true });

      // Step 4 — verify
      await sleep(300);
      const accepted = input.files && input.files.length > 0;
      console.log(`[MeeshoScan] ${field} accepted=${accepted} files=${input.files?.length}`);
      return accepted;

    } catch (err) {
      showNotification(`❌ Upload error: ${field}: ${err.message}`, true);
      console.warn('[MeeshoScan] injectFile error:', err);
      return false;
    }
  }

  async function triggerReactFileChange(input, fileList) {
    // Use the native prototype setter — this bypasses React's "last known value"
    // tracker which compares new vs old FileList by reference
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'files'
    )?.set;

    if (nativeSetter) {
      nativeSetter.call(input, fileList);
    } else {
      Object.defineProperty(input, 'files', {
        value: fileList, writable: true, configurable: true,
      });
    }

    // React 17/18 listens via event delegation on the root — fire both events
    input.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    await sleep(30);
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await sleep(50);

    // Also call the React fiber's onChange prop directly — needed for components
    // that use createRef / useRef and read files from the ref, not from events
    const fiberKey = Object.keys(input).find(k =>
      k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (fiberKey) {
      let fiber = input[fiberKey];
      let steps = 0;
      while (fiber && steps++ < 15) {
        const onChange = fiber.memoizedProps?.onChange;
        if (typeof onChange === 'function') {
          try {
            // Build a synthetic event that looks like what React would produce
            const nativeEvt = new Event('change', { bubbles: true });
            Object.defineProperty(nativeEvt, 'target', { value: input, configurable: true });
            onChange({
              target: input,
              currentTarget: input,
              nativeEvent: nativeEvt,
              bubbles: true,
              cancelable: true,
              defaultPrevented: false,
              preventDefault()  {},
              stopPropagation() {},
              isPropagationStopped() { return false; },
              isDefaultPrevented()   { return false; },
              persist() {},
              type: 'change',
            });
          } catch (e) {
            console.warn('[MeeshoScan] fiber onChange error:', e);
          }
          break;
        }
        fiber = fiber.return;
      }
    }
    await sleep(50);
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
