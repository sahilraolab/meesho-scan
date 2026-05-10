// Content script — runs on supplier.meesho.com
// Connects to WS server, handles AWB scans, extracts sub-orders, fills claim forms.
// Also injects a floating UI button that shows the same status/claims as the popup.

(function () {
  'use strict';

  let alive = true;

  // When the page navigates/redirects, Chrome can invalidate the content-script context.
  // Guard all async callbacks using `alive` to prevent crashes like:
  // "Extension context invalidated".
  window.addEventListener('pagehide', () => { alive = false; }, { capture: true });
  window.addEventListener('beforeunload', () => { alive = false; }, { capture: true });

  let ws           = null;
  let token        = null;
  let serverUrl    = null;
  let email        = null;
  let reconnTimer  = null;
  let floatPanel   = null;
  let floatVisible = false;

  // ── Load config & connect ─────────────────────────────────────────────────

  function loadAndConnect() {
    if (!alive) return;
    chrome.storage.local.get(['serverUrl', 'token', 'email'], (data) => {
      if (!alive) return;
      serverUrl = (data.serverUrl || '').replace(/\/$/, '');
      token     = data.token || null;
      email     = data.email || null;
      if (token && serverUrl) {
        connect();
      } else {
        setIndicator('error', 'Meesho Scan: Not signed in');
      }
    });
  }


  // ── WebSocket ─────────────────────────────────────────────────────────────

  function wsUrl() {
    // Replace http(s) scheme with ws(s) — keep host, port, and path intact
    return serverUrl.replace(/^https?:\/\//, (m) => m === 'https://' ? 'wss://' : 'ws://');
  }

  function connect() {
    clearTimeout(reconnTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }

    setIndicator('disconnected', 'Meesho Scan: Connecting…');

    let wsInst;
    try {
      wsInst = new WebSocket(wsUrl());
    } catch (e) {
      setIndicator('error', 'Meesho Scan: Bad server URL');
      reconnTimer = setTimeout(loadAndConnect, 8000);
      return;
    }
    ws = wsInst;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token, role: 'extension' }));
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case 'auth_ok':
          setIndicator('connected', 'Meesho Scan: Connected');
          break;
        case 'auth_error':
          setIndicator('error', 'Meesho Scan: Auth Error');
          // Don't reconnect on auth error — user needs to re-login
          return;
        case 'peer_connected':
          if (msg.role === 'mobile') showNotif('📱 Scanner connected', false, 2000);
          break;
        case 'peer_disconnected':
          if (msg.role === 'mobile') showNotif('📱 Scanner disconnected', true, 2500);
          break;
        case 'session_replaced':
          setIndicator('error', 'Session replaced');
          ws = null;
          return;
        case 'scan':
          handleScan(msg.awb, msg.ts, msg.scanId);
          break;
        case 'claim':
          handleClaimReceived(msg);
          break;
      }
    };

    ws.onclose = (ev) => {
      if (ws !== wsInst) return;
      setIndicator('disconnected', 'Meesho Scan: Disconnected');
      const delay = (ev.code === 1008 || ev.code === 1011) ? 8000 : 4000;
      reconnTimer = setTimeout(loadAndConnect, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror and handles reconnect
      setIndicator('disconnected', 'Meesho Scan: Offline');
    };
  }

  // ── Scan handling ──────────────────────────────────────────────────────────

  async function handleScan(awb, ts, scanId) {
    showNotif(`📦 Scanning: ${awb}`);

    const isReturns = /\/returns/i.test(location.pathname);
    if (!isReturns) {
      chrome.storage.local.set({ pendingAWB: awb, pendingScanId: scanId }, () => {
        window.location.href = 'https://supplier.meesho.com/returns';
      });
      return;
    }

    await searchAWB(awb, scanId);
  }

  // ── Search AWB on Returns page ────────────────────────────────────────────

  async function searchAWB(awb, scanId) {
    showNotif(`🔍 Searching ${awb}…`);

    try {
      const input = await waitForElement(
        'input[placeholder="Search by Order ID, SKU or AWB Number"]',
        8000
      );
      if (!input) { showNotif('❌ Search input not found', true); return; }

      input.focus();
      fillReactInput(input, awb);
      await sleep(300);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));

      // Wait for results
      await sleep(3000);

      const subOrderId = extractSubOrderId();
      if (subOrderId) {
        ws.send(JSON.stringify({ type: 'suborder_found', awb, subOrderId, scanId }));
        showNotif(`✅ Sub order found: ${subOrderId}`);
      } else {
        // Still send back so mobile can enable the OK/Wrong Item buttons
        ws.send(JSON.stringify({ type: 'suborder_found', awb, subOrderId: null, scanId }));
        showNotif(`ℹ️ Searched: ${awb} — no sub order found`);
      }
    } catch (err) {
      console.error('[MeeshoScan] searchAWB:', err);
      showNotif(`❌ Search failed: ${err.message}`, true);
    }
  }

  function extractSubOrderId() {
    const selectors = [
      'table tbody tr',
      '.m_177_l5ohi10 tbody tr',
      'tbody tr',
      '[role="table"] tr',
    ];

    for (const selector of selectors) {
      const rows = document.querySelectorAll(selector);
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;
        for (let i = 0; i < Math.min(cells.length, 3); i++) {
          const text = (cells[i].textContent || '').replace(/\s+/g, '').trim();
          if (/^\d+_\d+$/.test(text)) return text;
        }
      }
    }
    return null;
  }

  // ── Claim received (from server WS) ───────────────────────────────────────

  function handleClaimReceived(msg) {
    showNotif(`🎫 Claim for ${msg.awb || '?'} — click Fill Form in extension popup`);
    updateFloatPanel();
  }

  // ── Fill claim form on Meesho Returns ─────────────────────────────────────

  async function fillClaimById(claimId) {
    const data = await chromeGet(['pendingFillClaim']);
    if (data.pendingFillClaim?.claimId === claimId) {
      chrome.storage.local.remove('pendingFillClaim');
      await fillClaimForm(data.pendingFillClaim);
      // Mark as filled in storage so popup reflects the filled state
      chrome.storage.local.get(['filledClaims'], ({ filledClaims = [] }) => {
        if (!filledClaims.includes(claimId)) {
          chrome.storage.local.set({ filledClaims: [...filledClaims, claimId] });
        }
      });
      return;
    }
    showNotif('Claim data not found — try Fill Form again', true);
  }

  async function fillClaimForm(claim) {
    const { claimId, awb, subOrderNum, packetId, files } = claim;
    showNotif('🎫 Filling claim form…');

    try {
      const { token: tok, serverUrl: srv } = await chromeGet(['token', 'serverUrl']);
      const base = (srv || '').replace(/\/$/, '');

      if (subOrderNum) {
        const inp = await waitForElement('input[placeholder="Sub Order Number"]', 5000);
        if (inp) { fillReactInput(inp, subOrderNum); await sleep(200); }
      }

      if (packetId) {
        const inp = document.querySelector('input[placeholder="Packet ID"]');
        if (inp) { fillReactInput(inp, packetId); await sleep(200); }
      }

      if (awb) {
        const awbInput = document.querySelector('[role="combobox"] input[aria-autocomplete="list"]');
        if (awbInput) {
          awbInput.focus();
          fillReactInput(awbInput, awb);
          await sleep(800);
          const openBtn = document.querySelector('[role="combobox"] button[aria-label="Open menu"]');
          if (openBtn) openBtn.click();
          await sleep(600);
          const option = document.querySelector('[role="option"]');
          if (option) option.click();
          await sleep(300);
        }
      }

      if (base && tok) {
        const fileMap = [
          { field: 'barcode_image',   selectors: ['input[id^="barcode_image_link"]', 'input[id*="barcode"]'] },
          { field: 'product_image',   selectors: ['input[id^="product_image_link"]', 'input[id*="product_image"]'] },
          { field: 'reverse_waybill', selectors: ['input[id^="product_reverse_way_bill_link"]', 'input[id*="reverse_way_bill"]', 'input[id*="waybill"]'] },
          { field: 'unpacking_video', selectors: ['input[id^="product_openingvideo_link"]', 'input[id*="openingvideo"]', 'input[accept*="video"]'] },
        ];

        for (const { field, selectors: sels } of fileMap) {
          if (!files?.[field]) continue;
          showNotif(`📎 Uploading ${field.replace(/_/g, ' ')}…`);

          let inp = null;
          for (const sel of sels) {
            inp = await waitForElement(sel, sel === sels[0] ? 8000 : 1500);
            if (inp) break;
          }
          if (!inp) { showNotif(`⚠️ Input not found: ${field}`, true); continue; }

          const ok = await injectFile(inp, `${base}/api/claim/${claimId}/${field}`, tok, field);
          if (ok) showNotif(`✅ ${field.replace(/_/g, ' ')} uploaded`);
          else    showNotif(`⚠️ ${field.replace(/_/g, ' ')} may not have uploaded — check form`, true);
          await sleep(1000);
        }
      }

      showNotif('✅ Form filled — add description and submit');
    } catch (err) {
      console.error('[MeeshoScan] fillClaimForm:', err);
      showNotif(`❌ Fill error: ${err.message}`, true);
    }
  }

  function fillReactInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function fetchFileViaBackground(url, tok) {
    const resp = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'fetch_file', url, token: tok }, resolve)
    );
    if (!resp?.ok) throw new Error(resp?.error || `HTTP ${resp?.status}`);
    const mimeToExt = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
      'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    };
    const mime = resp.mime || 'application/octet-stream';
    const ext  = mimeToExt[mime] || mime.split('/')[1] || 'bin';
    const blob = new Blob([new Uint8Array(resp.bytes)], { type: mime });
    return new File([blob], `${url.split('/').pop()}.${ext}`, { type: mime });
  }

  async function injectFile(input, url, tok, field) {
    try {
      const file = await fetchFileViaBackground(url, tok);
      const dt   = new DataTransfer();
      dt.items.add(file);

      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this === input) return;
        origClick.call(this);
      };

      await triggerReactFileChange(input, dt.files);

      HTMLInputElement.prototype.click = origClick;
      await sleep(300);
      return input.files && input.files.length > 0;
    } catch (err) {
      showNotif(`❌ Upload error: ${field}: ${err.message}`, true);
      return false;
    }
  }

  async function triggerReactFileChange(input, fileList) {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'files')?.set;
    if (nativeSetter) nativeSetter.call(input, fileList);
    else Object.defineProperty(input, 'files', { value: fileList, writable: true, configurable: true });

    input.dispatchEvent(new Event('input',  { bubbles: true, cancelable: true }));
    await sleep(30);
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await sleep(50);

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
            const ev = new Event('change', { bubbles: true });
            Object.defineProperty(ev, 'target', { value: input, configurable: true });
            onChange({ target: input, currentTarget: input, nativeEvent: ev, bubbles: true,
              cancelable: true, defaultPrevented: false,
              preventDefault() {}, stopPropagation() {},
              isPropagationStopped() { return false; }, isDefaultPrevented() { return false; },
              persist() {}, type: 'change' });
          } catch {}
          break;
        }
        fiber = fiber.return;
      }
    }
    await sleep(50);
  }

  function chromeGet(keys) {
    return new Promise((resolve, reject) => {
      try { chrome.storage.local.get(keys, resolve); }
      catch (e) { reject(e); }
    });
  }

  // ── Pending checks after navigation ───────────────────────────────────────

  function checkPendingAWB() {
    chrome.storage.local.get(['pendingAWB', 'pendingScanId'], (data) => {
      if (!data.pendingAWB) return;
      const awb = data.pendingAWB;
      const scanId = data.pendingScanId || null;
      chrome.storage.local.remove(['pendingAWB', 'pendingScanId'], async () => {
        await sleep(2000);
        if (/\/returns/i.test(location.pathname)) await searchAWB(awb, scanId);
      });
    });
  }

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

  // ── Helpers ───────────────────────────────────────────────────────────────

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

  // ── Floating indicator + panel ─────────────────────────────────────────────
  // Clicking the indicator toggles a mini extension-like panel on the page.

  let indicator = null;

  function createIndicator() {
    indicator = document.createElement('div');
    indicator.id = '__ms_indicator__';
    Object.assign(indicator.style, {
      position: 'fixed', bottom: '16px', right: '16px', zIndex: '2147483647',
      background: '#fff', border: '1.5px solid #e5e5e5', borderRadius: '24px',
      padding: '7px 14px', fontSize: '12px', fontFamily: 'system-ui, sans-serif',
      fontWeight: '600', color: '#666', boxShadow: '0 2px 12px rgba(0,0,0,0.12)',
      display: 'flex', alignItems: 'center', gap: '7px',
      cursor: 'pointer', userSelect: 'none', transition: 'box-shadow 0.2s',
    });
    indicator.addEventListener('click', toggleFloatPanel);
    document.body.appendChild(indicator);
  }

  function setIndicator(state, label) {
    if (!indicator) createIndicator();
    const colors = { connected: '#16a34a', disconnected: '#d97706', error: '#dc2626' };
    const dot = colors[state] || colors.disconnected;
    indicator.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${dot};display:inline-block;flex-shrink:0;"></span>${label || 'Meesho Scan'}`;
  }

  function toggleFloatPanel() {
    if (!floatPanel) createFloatPanel();
    floatVisible = !floatVisible;
    floatPanel.style.display = floatVisible ? 'flex' : 'none';
    if (floatVisible) updateFloatPanel();
  }

  function createFloatPanel() {
    floatPanel = document.createElement('div');
    floatPanel.id = '__ms_panel__';
    Object.assign(floatPanel.style, {
      position: 'fixed', bottom: '56px', right: '16px', zIndex: '2147483647',
      background: '#fff', border: '1.5px solid #e5e7eb', borderRadius: '14px',
      width: '300px', maxHeight: '480px', overflowY: 'auto',
      boxShadow: '0 8px 32px rgba(0,0,0,0.15)',
      flexDirection: 'column', padding: '0',
      fontFamily: 'system-ui, sans-serif', fontSize: '13px', color: '#111827',
      display: 'none',
    });

    floatPanel.innerHTML = `
      <div style="padding:12px 14px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between;">
        <span style="font-weight:700; font-size:14px;">📦 Meesho Scan</span>
        <span id="__ms_close__" style="cursor:pointer; color:#9ca3af; font-size:18px; line-height:1;">×</span>
      </div>
      <div style="padding:12px 14px;">
        <div id="__ms_status_ext__" style="padding:8px 10px; border-radius:7px; font-size:12px; font-weight:500; margin-bottom:8px; background:#fef3c7; color:#d97706;">⚡ Checking…</div>
        <div id="__ms_status_mob__" style="padding:8px 10px; border-radius:7px; font-size:12px; font-weight:500; margin-bottom:12px; background:#fef3c7; color:#d97706;">📱 Scanner: —</div>
        
        <div style="font-weight:700; font-size:12px; margin-bottom:8px; color:#374151;">Manual AWB Search</div>
        <div style="display:flex; gap:6px; margin-bottom:12px;">
          <input id="__ms_awb_input__" type="text" placeholder="Enter AWB…" style="flex:1; border:1.5px solid #e5e7eb; border-radius:7px; padding:8px 10px; font-size:13px; outline:none; font-family:monospace;" />
          <button id="__ms_awb_go__" style="background:#f43397; color:#fff; border:none; border-radius:7px; padding:8px 12px; font-size:12px; font-weight:600; cursor:pointer;">Go</button>
        </div>

        <div style="border-top:1px solid #e5e7eb; padding-top:12px;">
          <div style="font-weight:700; font-size:12px; margin-bottom:8px; color:#374151;">Pending Claims</div>
          <div id="__ms_claims_list__" style="display:flex; flex-direction:column; gap:6px;">
            <div style="color:#9ca3af; font-size:12px;">Loading…</div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(floatPanel);

    floatPanel.querySelector('#__ms_close__').addEventListener('click', (e) => {
      e.stopPropagation();
      floatVisible = false;
      floatPanel.style.display = 'none';
    });

    const goBtn = floatPanel.querySelector('#__ms_awb_go__');
    const awbIn = floatPanel.querySelector('#__ms_awb_input__');
    const doSearch = () => {
      const awb = awbIn.value.trim().toUpperCase();
      if (!awb) return;
      awbIn.value = '';
      handleScan(awb, Date.now(), null);
    };
    goBtn.addEventListener('click', doSearch);
    awbIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  }

  async function updateFloatPanel() {
    if (!floatPanel || !floatVisible) return;
    try {
      const { token: tok, serverUrl: srv } = await chromeGet(['token', 'serverUrl']);
      if (!tok || !srv) return;

      const base = (srv || '').replace(/\/$/, '');
      const [statusRes, claimsRes] = await Promise.all([
        fetch(`${base}/api/status`, { headers: { Authorization: `Bearer ${tok}` } }),
        fetch(`${base}/api/claims`, { headers: { Authorization: `Bearer ${tok}` } }),
      ]);

      if (statusRes.ok) {
        const s = await statusRes.json();
        const extEl = floatPanel.querySelector('#__ms_status_ext__');
        const mobEl = floatPanel.querySelector('#__ms_status_mob__');
        if (extEl) {
          extEl.textContent = s.extensionConnected ? '✅ Meesho tab: Active' : '⚠️ Meesho tab not open';
          extEl.style.background = s.extensionConnected ? '#dcfce7' : '#fef3c7';
          extEl.style.color      = s.extensionConnected ? '#16a34a' : '#d97706';
        }
        if (mobEl) {
          mobEl.textContent = s.mobileConnected ? '📱 Scanner: Connected' : '📱 Scanner: Not connected';
          mobEl.style.background = s.mobileConnected ? '#dcfce7' : '#fef3c7';
          mobEl.style.color      = s.mobileConnected ? '#16a34a' : '#d97706';
        }
      }

      if (claimsRes.ok) {
        const claims = await claimsRes.json();
        const list = floatPanel.querySelector('#__ms_claims_list__');
        if (list) {
          if (!claims.length) {
            list.innerHTML = '<div style="color:#9ca3af; font-size:12px; text-align:center; padding:8px 0;">No pending claims</div>';
          } else {
            list.innerHTML = claims.slice(0, 5).map(c => {
              const fileCount = Object.keys(c.files || {}).length;
              const canFill = fileCount > 0;
              return `<div style="background:#f8f9fb; border:1.5px solid #e5e7eb; border-radius:9px; padding:10px 12px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                  <span style="font-weight:700; font-family:monospace; font-size:13px;">${c.awb || '—'}</span>
                  <span style="font-size:10px; color:#9ca3af;">${new Date(c.ts).toLocaleDateString()}</span>
                </div>
                ${c.subOrderNum ? `<div style="font-size:11px; color:#6b7280; margin-bottom:6px;">Sub: ${c.subOrderNum}</div>` : ''}
                <button data-claim-id="${c.claimId}" style="
                  width:100%; padding:5px 8px; border:none; border-radius:6px;
                  background:${canFill ? '#f43397' : '#d1d5db'}; color:${canFill ? '#fff' : '#9ca3af'};
                  font-size:11px; font-weight:600; cursor:${canFill ? 'pointer' : 'default'};
                ">${canFill ? 'Fill Meesho Form →' : '⚠️ Add media in scanner app'}</button>
              </div>`;
            }).join('');
            // Bind fill buttons
            list.querySelectorAll('[data-claim-id]').forEach(btn => {
              btn.addEventListener('click', async () => {
                const claimId = btn.dataset.claimId;
                const claim = claims.find(c => c.claimId === claimId);
                if (!claim || Object.keys(claim.files || {}).length === 0) return;
                if (claim) await fillClaimForm(claim);
              });
            });
          }
        }
      }
    } catch {}
  }

  // ── Notification banner ───────────────────────────────────────────────────

  let notifEl = null;
  let notifTimer = null;

  function showNotif(msg, isError = false, duration = 3500) {
    if (!notifEl) {
      notifEl = document.createElement('div');
      notifEl.id = '__ms_notif__';
      Object.assign(notifEl.style, {
        position: 'fixed', top: '16px', right: '16px', zIndex: '2147483647',
        background: '#1a1a1a', color: '#fff', borderRadius: '10px',
        padding: '12px 18px', fontSize: '14px', fontFamily: 'system-ui, sans-serif',
        fontWeight: '500', boxShadow: '0 4px 20px rgba(0,0,0,0.2)',
        transition: 'opacity 0.3s, transform 0.3s', maxWidth: '320px', lineHeight: '1.4',
        transform: 'translateY(0)',
      });
      document.body.appendChild(notifEl);
    }
    notifEl.textContent = msg;
    notifEl.style.background = isError ? '#dc2626' : '#1a1a1a';
    notifEl.style.opacity = '1';
    notifEl.style.transform = 'translateY(0)';
    clearTimeout(notifTimer);
    notifTimer = setTimeout(() => {
      notifEl.style.opacity = '0';
      notifEl.style.transform = 'translateY(-4px)';
    }, duration);
  }

  // ── Message listeners ─────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'reconnect') {
      loadAndConnect();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'manual_scan') {
      handleScan(msg.awb, Date.now(), null);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'fill_claim') {
      (async () => {
        try {
          if (msg.claim) await fillClaimForm(msg.claim);
          else await fillClaimById(msg.claimId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true; // keep channel open for async response
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.token || changes.serverUrl) loadAndConnect();
  });

  // ── Init ──────────────────────────────────────────────────────────────────

  setTimeout(() => {
    checkPendingAWB();
    checkPendingFillClaim();
    loadAndConnect();
  }, 1500);

})();