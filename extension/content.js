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

  // Safe send — silently drops if socket is not open (avoids crash when WS
  // disconnects during the 3s wait after search)
  function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    console.warn('[MeeshoScan] wsSend: socket not open, dropped:', payload.type);
    return false;
  }

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
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'auth', token, role: 'extension' }));
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

      const { subOrderId, deliveryDate } = extractSubOrderInfo();
      if (subOrderId) {
        wsSend({ type: 'suborder_found', awb, subOrderId, deliveryDate, scanId });
        showNotif(`✅ Sub order found: ${subOrderId}`);
      } else {
        // Still send back so mobile can enable the OK/Wrong Item buttons
        wsSend({ type: 'suborder_found', awb, subOrderId: null, deliveryDate: null, scanId });
        showNotif(`ℹ️ Searched: ${awb} — no sub order found`);
      }
    } catch (err) {
      console.error('[MeeshoScan] searchAWB:', err);
      showNotif(`❌ Search failed: ${err.message}`, true);
    }
  }

  // Returns { subOrderId, deliveryDate } from the Meesho returns table.
  // Table column order: Product(0) | Suborder(1) | Status(2) | Created(3) | Delivery(4) | Reason(5) | Action(6)
  // deliveryDate is an ISO date string (YYYY-MM-DD) parsed from Meesho's "5 May'26" format.
  function extractSubOrderInfo() {
    const selectors = [
      'table tbody tr',
      '.m_177_l5ohi10 tbody tr',
      'tbody tr',
      '[role="table"] tr',
    ];

    const MONTH_MAP = {
      jan:0, feb:1, mar:2, apr:3, may:4, jun:5,
      jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
    };

    function parseMeeshoDate(raw) {
      // Handles "5 May'26", "12 Jan'25", "5 May 2026" etc.
      const clean = raw.replace(/\s+/g, ' ').trim();
      // Pattern: day MonAbbr'YY  e.g. "5 May'26"
      let m = clean.match(/^(\d{1,2})\s+([A-Za-z]{3})'(\d{2})$/);
      if (m) {
        const day   = parseInt(m[1], 10);
        const month = MONTH_MAP[m[2].toLowerCase()];
        const year  = 2000 + parseInt(m[3], 10);
        if (month !== undefined) {
          const d = new Date(year, month, day);
          return d.toISOString().split('T')[0]; // YYYY-MM-DD
        }
      }
      // Pattern: day Month YYYY e.g. "5 May 2026"
      m = clean.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
      if (m) {
        const day   = parseInt(m[1], 10);
        const month = MONTH_MAP[m[2].slice(0,3).toLowerCase()];
        const year  = parseInt(m[3], 10);
        if (month !== undefined) {
          const d = new Date(year, month, day);
          return d.toISOString().split('T')[0];
        }
      }
      return null;
    }

    for (const selector of selectors) {
      const rows = document.querySelectorAll(selector);
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) continue;

        // Find subOrderId — look in first 3 cells for pattern digits_digits
        let subOrderId = null;
        for (let i = 0; i < Math.min(cells.length, 3); i++) {
          const text = (cells[i].textContent || '').replace(/\s+/g, '').trim();
          if (/^\d+_\d+$/.test(text)) { subOrderId = text; break; }
        }
        if (!subOrderId) continue;

        // Extract delivery/delivered date from column index 4
        // The cell contains text like "5 May'26" possibly followed by tooltip/icon text
        let deliveryDate = null;
        if (cells.length > 4) {
          // The date is the first meaningful text node inside the cell
          // Strip any nested SVG/tooltip text by reading only text nodes
          const cell = cells[4];
          // Try the vj3rjv1 date div first (Meesho's date wrapper class)
          const dateDiv = cell.querySelector('.vj3rjv1, [class*="vj3rjv1"]');
          const rawDate = dateDiv
            ? (dateDiv.firstChild?.textContent || dateDiv.textContent || '').trim()
            : '';
          if (rawDate) deliveryDate = parseMeeshoDate(rawDate);

          // Fallback: walk text nodes directly in the cell
          if (!deliveryDate) {
            const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              const t = node.textContent.trim();
              if (/\d{1,2}\s+[A-Za-z]/.test(t)) {
                deliveryDate = parseMeeshoDate(t);
                if (deliveryDate) break;
              }
            }
          }
        }

        console.log(`[MeeshoScan] extracted subOrderId=${subOrderId} deliveryDate=${deliveryDate}`);
        return { subOrderId, deliveryDate };
      }
    }
    return { subOrderId: null, deliveryDate: null };
  }

  // Keep backward-compat alias
  function extractSubOrderId() {
    return extractSubOrderInfo().subOrderId;
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
    const { claimId, awb, subOrderNum, packetId, files, packetState } = claim;
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

      // Fill "State of the packet" dropdown
      if (packetState) {
        const targetLabel = packetState === 'tampered' ? 'Tampered' : 'Intact';

        // Find container via stable .dropdown_label class
        let container = null;
        for (const lbl of document.querySelectorAll('.dropdown_label, [class*="dropdown_label"]')) {
          if (lbl.textContent.includes('State of the packet')) {
            container = lbl.closest('.css-79elbk') || lbl.parentElement?.parentElement;
            break;
          }
        }
        // Fallback: search all css-79elbk boxes by text content
        if (!container) {
          for (const box of document.querySelectorAll('.css-79elbk')) {
            if (box.textContent.includes('State of the packet')) { container = box; break; }
          }
        }

        if (container) {
          // Click first child (the header row, regardless of emotion class)
          const header = container.firstElementChild;
          if (header) { header.click(); await sleep(400); }

          // Options appear dynamically — poll for up to 3s
          let optList = null;
          for (let i = 0; i < 15; i++) {
            optList = container.querySelector('.css-iy3o0x') || document.querySelector('.css-iy3o0x');
            if (optList) break;
            await sleep(200);
          }

          if (optList) {
            for (const p of optList.querySelectorAll('p')) {
              if (p.textContent.trim() === targetLabel) {
                p.click();
                await sleep(200);
                showNotif(`✅ Packet state: ${targetLabel}`);
                break;
              }
            }
          }
        }
      }

      if (base && tok) {
        const fileMap = [
          { field: 'barcode_image',   selectors: ['input[id^="barcode_image_link"]', 'input[id*="barcode"]'], wait: 8000 },
          { field: 'product_image',   selectors: ['input[id^="product_image_link"]', 'input[id*="product_image"]'], wait: 8000 },
          { field: 'reverse_waybill', selectors: ['input[id^="product_reverse_way_bill_link"]', 'input[id*="reverse_way_bill"]', 'input[id*="waybill"]'], wait: 8000 },
          // Video input: longer wait (12s) + scroll into view + retry
          // NEVER use input[accept*="video"] — too broad, matches unrelated inputs
          { field: 'unpacking_video', selectors: ['input[id^="product_openingvideo_link"]', 'input[id*="openingvideo"]', 'input[id*="opening_video"]', 'input[id*="unpackingvideo"]'], wait: 12000 },
        ];

        for (const { field, selectors: sels, wait: waitMs } of fileMap) {
          if (!files?.[field]) continue;
          showNotif(`📎 Uploading ${field.replace(/_/g, ' ')}…`);

          // Find the input — try each selector, first gets full wait budget, rest get 2s
          let inp = null;
          for (let si = 0; si < sels.length; si++) {
            inp = await waitForElement(sels[si], si === 0 ? waitMs : 2000);
            if (inp) { console.log(`[MeeshoScan] ${field} found via: ${sels[si]}`); break; }
          }

          if (!inp) {
            showNotif(`⚠️ Input not found: ${field}`, true);
            console.warn(`[MeeshoScan] no input found for ${field}, tried:`, sels);
            continue;
          }

          // Scroll input into view so React renders it fully before injection
          inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(field === 'unpacking_video' ? 800 : 300);

          // Fetch the file ONCE from the server, then retry only the DOM injection
          // (never re-fetch — that caused the video to be uploaded multiple times)
          let file;
          try {
            file = await fetchFileViaBackground(`${base}/api/claim/${claimId}/${field}`, tok);
          } catch (fetchErr) {
            showNotif(`❌ Fetch failed: ${field}: ${fetchErr.message}`, true);
            continue;
          }

          // Single injection attempt — no retry loop.
          // React accepts the file internally but doesn't always reflect it back on
          // input.files, so a retry loop just injects the same file multiple times.
          const ok = await injectFileFromBlob(inp, file, field);

          if (ok) showNotif(`✅ ${field.replace(/_/g, ' ')} uploaded`);
          else    showNotif(`⚠️ ${field.replace(/_/g, ' ')} may not have uploaded — check form`, true);
          await sleep(field === 'unpacking_video' ? 1500 : 1000);
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

  // Inject an already-fetched File object into a React input — no network call
  async function injectFileFromBlob(input, file, field) {
    try {
      const dt = new DataTransfer();
      dt.items.add(file);

      const origClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () { if (this === input) return; origClick.call(this); };

      await triggerReactFileChange(input, dt.files);

      HTMLInputElement.prototype.click = origClick;

      // Give React time to process the synthetic event before checking
      await sleep(field === 'unpacking_video' ? 600 : 300);
      return input.files && input.files.length > 0;
    } catch (err) {
      showNotif(`❌ Inject error: ${field}: ${err.message}`, true);
      return false;
    }
  }

  // Convenience wrapper: fetch + inject in one call (used outside the fileMap loop)
  async function injectFile(input, url, tok, field) {
    try {
      const file = await fetchFileViaBackground(url, tok);
      return await injectFileFromBlob(input, file, field);
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
      if (!data.pendingFillClaimId && !data.pendingFillClaim) return;
      const claim   = data.pendingFillClaim || null;
      const claimId = data.pendingFillClaimId;
      chrome.storage.local.remove(['pendingFillClaimId', 'pendingFillClaim'], async () => {
        await sleep(2000);
        if (claim) await fillClaimForm(claim);
        else await fillClaimById(claimId);
      });
    });
  }

  // Navigate to the saved per-type claim URL, storing claim for form-fill on arrival.
  // Falls back to direct fill if no URL is configured for the claim type.
  async function fillClaimOrNavigate(claim) {
    if (!alive) return;
    try {
      const { claimUrls = {} } = await chromeGet(['claimUrls']);
      const targetUrl = claimUrls[claim.claimType || 'wrong_return'];
      if (targetUrl) {
        await new Promise(r => chrome.storage.local.set({ pendingFillClaim: claim }, r));
        window.location.href = targetUrl;
      } else {
        await fillClaimForm(claim);
      }
    } catch (err) {
      showNotif(`❌ Fill error: ${err.message}`, true);
    }
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

  let indicator    = null;
  let indicatorState = 'disconnected';

  const CLAIM_TYPE_META = {
    wrong_return:   { label: 'Wrong Return',   color: '#d97706', bg: '#fef3c7' },
    damaged_return: { label: 'Damaged',        color: '#dc2626', bg: '#fee2e2' },
    missing_items:  { label: 'Missing Items',  color: '#2563eb', bg: '#dbeafe' },
    used_product:   { label: 'Used Product',   color: '#7c3aed', bg: '#ede9fe' },
  };

  function createIndicator() {
    indicator = document.createElement('div');
    indicator.id = '__ms_indicator__';
    Object.assign(indicator.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
      background: '#fff', borderRadius: '28px',
      padding: '0', width: '44px', height: '44px',
      boxShadow: '0 2px 16px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'pointer', userSelect: 'none',
      transition: 'box-shadow 0.2s, transform 0.15s',
      fontFamily: 'system-ui, sans-serif',
    });
    indicator.addEventListener('mouseenter', () => {
      indicator.style.boxShadow = '0 4px 24px rgba(244,51,151,0.25), 0 0 0 1px rgba(244,51,151,0.2)';
      indicator.style.transform = 'scale(1.05)';
    });
    indicator.addEventListener('mouseleave', () => {
      indicator.style.boxShadow = '0 2px 16px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)';
      indicator.style.transform = 'scale(1)';
    });
    indicator.addEventListener('click', toggleFloatPanel);
    document.body.appendChild(indicator);
  }

  function setIndicator(state, _label) {
    if (!indicator) createIndicator();
    indicatorState = state;
    const dotColor = state === 'connected' ? '#16a34a' : state === 'error' ? '#dc2626' : '#d97706';
    indicator.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
        <span style="font-size:20px;line-height:1;">📦</span>
        <span style="width:6px;height:6px;border-radius:50%;background:${dotColor};display:block;"></span>
      </div>`;
    indicator.title = _label || 'Meesho Scan';
  }

  function toggleFloatPanel() {
    if (!floatPanel) createFloatPanel();
    floatVisible = !floatVisible;
    floatPanel.style.display = floatVisible ? 'flex' : 'none';
    if (floatVisible) updateFloatPanel();
    // Highlight indicator when panel is open
    indicator.style.background = floatVisible ? '#f43397' : '#fff';
    indicator.style.boxShadow  = floatVisible
      ? '0 4px 20px rgba(244,51,151,0.35)' : '0 2px 16px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)';
  }

  function createFloatPanel() {
    floatPanel = document.createElement('div');
    floatPanel.id = '__ms_panel__';
    Object.assign(floatPanel.style, {
      position: 'fixed', bottom: '72px', right: '20px', zIndex: '2147483647',
      background: '#fff', borderRadius: '16px',
      width: '320px', maxHeight: '540px', overflowY: 'auto',
      boxShadow: '0 12px 40px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)',
      flexDirection: 'column', padding: '0',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontSize: '13px', color: '#111827',
      display: 'none',
    });

    floatPanel.innerHTML = `
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#f43397,#e11d77); padding:14px 16px; border-radius:16px 16px 0 0; display:flex; align-items:center; justify-content:space-between; flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:20px;">📦</span>
          <span style="font-weight:700; font-size:14px; color:#fff; letter-spacing:-0.3px;">Meesho Scan</span>
        </div>
        <button id="__ms_close__" style="background:rgba(255,255,255,0.2);border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;color:#fff;font-size:16px;display:flex;align-items:center;justify-content:center;line-height:1;">×</button>
      </div>

      <!-- Status row -->
      <div style="padding:10px 14px 0; display:flex; gap:6px; flex-shrink:0;">
        <div id="__ms_status_ext__" style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border-radius:8px;font-size:11px;font-weight:600;background:#fef3c7;color:#d97706;">
          <span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;"></span>Tab
        </div>
        <div id="__ms_status_mob__" style="flex:1;display:flex;align-items:center;gap:5px;padding:6px 8px;border-radius:8px;font-size:11px;font-weight:600;background:#fef3c7;color:#d97706;">
          <span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;"></span>Scanner
        </div>
      </div>

      <!-- AWB Search -->
      <div style="padding:10px 14px 0; flex-shrink:0;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Manual AWB Search</div>
        <div style="display:flex; gap:6px;">
          <input id="__ms_awb_input__" type="text" placeholder="Enter AWB number…"
            style="flex:1;border:1.5px solid #e5e7eb;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:monospace;background:#f9fafb;color:#111827;" />
          <button id="__ms_awb_go__"
            style="background:#f43397;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;">
            Search
          </button>
        </div>
      </div>

      <!-- Claims -->
      <div style="padding:10px 14px 14px; flex:1; overflow-y:auto;">
        <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Pending Claims</div>
        <div id="__ms_claims_list__" style="display:flex;flex-direction:column;gap:8px;">
          <div style="color:#9ca3af;font-size:12px;text-align:center;padding:12px 0;">Loading…</div>
        </div>
      </div>
    `;

    document.body.appendChild(floatPanel);

    floatPanel.querySelector('#__ms_close__').addEventListener('click', (e) => {
      e.stopPropagation();
      floatVisible = false;
      floatPanel.style.display = 'none';
      if (indicator) {
        indicator.style.background = '#fff';
        indicator.style.boxShadow  = '0 2px 16px rgba(0,0,0,0.14), 0 0 0 1px rgba(0,0,0,0.06)';
      }
    });

    const goBtn = floatPanel.querySelector('#__ms_awb_go__');
    const awbIn = floatPanel.querySelector('#__ms_awb_input__');
    const awbInput = floatPanel.querySelector('#__ms_awb_input__');
    awbInput.addEventListener('focus', () => { awbInput.style.borderColor = '#f43397'; });
    awbInput.addEventListener('blur',  () => { awbInput.style.borderColor = '#e5e7eb'; });
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
      const { token: tok, serverUrl: srv, claimUrls = {} } = await chromeGet(['token', 'serverUrl', 'claimUrls']);
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
          const ok = s.extensionConnected;
          extEl.style.background = ok ? '#dcfce7' : '#fef3c7';
          extEl.style.color      = ok ? '#16a34a' : '#d97706';
          extEl.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;"></span>${ok ? 'Tab: Active' : 'Tab: Offline'}`;
        }
        if (mobEl) {
          const ok = s.mobileConnected;
          mobEl.style.background = ok ? '#dcfce7' : '#fef3c7';
          mobEl.style.color      = ok ? '#16a34a' : '#d97706';
          mobEl.innerHTML = `<span style="width:6px;height:6px;border-radius:50%;background:currentColor;flex-shrink:0;"></span>${ok ? 'Scanner: On' : 'Scanner: Off'}`;
        }
      }

      if (claimsRes.ok) {
        const claims = await claimsRes.json();
        const list = floatPanel.querySelector('#__ms_claims_list__');
        if (!list) return;

        if (!claims.length) {
          list.innerHTML = '<div style="color:#9ca3af;font-size:12px;text-align:center;padding:16px 0;">No pending claims</div>';
          return;
        }

        list.innerHTML = claims.slice(0, 6).map(c => {
          const fileCount = Object.keys(c.files || {}).length;
          const canFill   = fileCount > 0;
          const meta      = CLAIM_TYPE_META[c.claimType] || { label: 'Claim', color: '#6b7280', bg: '#f3f4f6' };
          const hasUrl    = !!claimUrls[c.claimType || 'wrong_return'];
          const packetLabel = c.packetState === 'tampered' ? '⚠️ Tampered' : c.packetState === 'intact' ? '✅ Intact' : '';

          const fillLabel = !canFill
            ? '⚠️ No media'
            : !hasUrl
            ? 'Fill Form (set URL first)'
            : 'Fill Form →';
          const fillBg    = !canFill ? '#d1d5db' : '#f43397';
          const fillColor = !canFill ? '#9ca3af' : '#fff';
          const fillCursor = canFill ? 'pointer' : 'default';

          return `<div style="background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:10px;padding:10px 12px;transition:border-color 0.15s;" data-card-id="${c.claimId}">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
              <span style="font-weight:700;font-family:monospace;font-size:13px;color:#111827;">${c.awb || '—'}</span>
              <span style="font-size:10px;color:#9ca3af;white-space:nowrap;margin-left:6px;">${new Date(c.ts).toLocaleDateString()}</span>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">
              <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;background:${meta.bg};color:${meta.color};">${meta.label}</span>
              ${packetLabel ? `<span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:20px;background:#f3f4f6;color:#374151;">${packetLabel}</span>` : ''}
              ${c.subOrderNum ? `<span style="font-size:10px;padding:2px 7px;border-radius:20px;background:#f3f4f6;color:#6b7280;font-family:monospace;">Sub: ${c.subOrderNum}</span>` : ''}
              ${fileCount ? `<span style="font-size:10px;padding:2px 7px;border-radius:20px;background:#ede9fe;color:#7c3aed;">📎 ${fileCount}</span>` : ''}
            </div>
            <button data-claim-id="${c.claimId}" style="width:100%;padding:6px;border:none;border-radius:7px;background:${fillBg};color:${fillColor};font-size:11px;font-weight:700;cursor:${fillCursor};letter-spacing:0.2px;">${fillLabel}</button>
          </div>`;
        }).join('');

        list.querySelectorAll('[data-card-id]').forEach(card => {
          card.addEventListener('mouseenter', () => { card.style.borderColor = '#f43397'; });
          card.addEventListener('mouseleave', () => { card.style.borderColor = '#e5e7eb'; });
        });

        list.querySelectorAll('[data-claim-id]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const claim = claims.find(c => c.claimId === btn.dataset.claimId);
            if (!claim || Object.keys(claim.files || {}).length === 0) return;
            await fillClaimOrNavigate(claim);
          });
        });
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