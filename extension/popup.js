'use strict';

const SERVER = 'https://scanserver.techseventeen.com';

let authMode     = 'login';
let currentClaims = [];

function $(id) { return document.getElementById(id); }

function showPanel(id) {
  $('panelAuth').classList.toggle('active', id === 'panelAuth');
  $('panelMain').classList.toggle('active', id === 'panelMain');
}

function setStatus(barId, textId, state, label) {
  $(barId).className = `status-bar ${state}`;
  $(textId).textContent = label;
}

function formatTime(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

// ── Auth mode toggle ──────────────────────────────────────────────────────────

function toggleMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  $('authSubtitle').textContent = authMode === 'login'
    ? 'Sign in to your account' : 'Create a new account';
  $('authBtn').textContent = authMode === 'login' ? 'Sign In' : 'Sign Up';
  $('authToggle').textContent = authMode === 'login'
    ? "Don't have an account? Sign up" : 'Already have an account? Sign in';
  $('authErr').textContent = '';
}

// ── Auth ──────────────────────────────────────────────────────────────────────

async function submitAuth() {
  const email    = $('authEmail').value.trim();
  const password = $('authPassword').value;
  $('authErr').textContent = '';

  if (!email)    { $('authErr').textContent = 'Email is required.'; return; }
  if (!password) { $('authErr').textContent = 'Password is required.'; return; }

  const btn = $('authBtn');
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div>';

  try {
    const res = await fetch(`${SERVER}/auth/${authMode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    let data;
    try { data = await res.json(); }
    catch { throw new Error(`Server error (${res.status})`); }
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);

    await chrome.storage.local.set({ token: data.token, email: data.email, serverUrl: SERVER });

    chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
      for (const tab of tabs)
        chrome.tabs.sendMessage(tab.id, { type: 'reconnect' }).catch(() => {});
    });

    loadMainPanel();
  } catch (err) {
    $('authErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === 'login' ? 'Sign In' : 'Sign Up';
  }
}

function logout() {
  chrome.storage.local.remove(['token', 'email', 'serverUrl'], () => {
    showPanel('panelAuth');
  });
}

// ── Main panel ────────────────────────────────────────────────────────────────

async function loadMainPanel() {
  showPanel('panelMain');
  const { token, email, scanLog = [] } =
    await chrome.storage.local.get(['token', 'email', 'scanLog']);
  $('userEmail').textContent = email || '';
  refreshStatus(token);
  loadClaims(token);
  
  // Fetch scan logs from server API for persistent storage
  let serverLogs = [];
  if (token) {
    try {
      const res = await fetch(`${SERVER}/api/logs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        serverLogs = await res.json();
        // Merge with local logs, removing duplicates by AWB
        const merged = [...scanLog];
        for (const log of serverLogs) {
          if (!merged.some(l => l.awb === log.awb && l.ts === log.ts)) {
            merged.push({ ...log, receivedAt: log.ts });
          }
        }
        // Sort by timestamp descending
        merged.sort((a, b) => (b.receivedAt || b.ts) - (a.receivedAt || a.ts));
        renderLog(merged);
        return;
      }
    } catch {}
  }
  renderLog(scanLog);
}

async function refreshStatus(token) {
  if (!token) return;
  try {
    const res = await fetch(`${SERVER}/api/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error();
    const s = await res.json();

    setStatus('wsStatus', 'wsStatusText',
      s.extensionConnected ? 'connected' : 'warning',
      s.extensionConnected ? 'Meesho Returns tab: active' : 'Meesho Returns tab not open'
    );
    const openBtn = $('openMeeshoBtn');
    if (!s.extensionConnected) {
      chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
        openBtn.textContent = tabs.length ? 'Reload tab →' : 'Open Returns →';
        openBtn.style.display = 'inline-block';
      });
    } else {
      openBtn.style.display = 'none';
    }

    setStatus('extStatus', 'extStatusText',
      s.mobileConnected ? 'connected' : 'warning',
      s.mobileConnected ? 'Phone: connected' : 'Phone: not connected'
    );
  } catch {
    setStatus('wsStatus', 'wsStatusText', 'disconnected', 'Cannot reach server');
    $('openMeeshoBtn').style.display = 'none';
  }
}

// ── Claims ────────────────────────────────────────────────────────────────────

async function loadClaims(token) {
  if (!token) return;
  try {
    const res = await fetch(`${SERVER}/api/claims`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const claims = await res.json();
    // Read locally tracked "filled" IDs so the UI stays accurate
    const { filledClaims = [] } = await chrome.storage.local.get(['filledClaims']);
    const filledSet = new Set(filledClaims);
    currentClaims = claims.map(c => ({ ...c, receivedAt: c.ts, filled: filledSet.has(c.claimId) }));
    renderClaims(currentClaims);
  } catch {}
}

function renderClaims(queue) {
  const list     = $('claimList');
  const badge    = $('claimBadge');
  const clearBtn = $('clearClaimsBtn');

  if (!queue || !queue.length) {
    list.innerHTML = '<div class="empty">No pending claims</div>';
    badge.style.display  = 'none';
    clearBtn.style.display = 'none';
    return;
  }

  const pending = queue.filter(c => !c.filled);
  badge.textContent    = pending.length || '';
  badge.style.display  = pending.length ? 'inline-flex' : 'none';
  clearBtn.style.display = 'block';

  list.innerHTML = queue.map(c => {
    const fileCount = Object.keys(c.files || {}).length;
    const tags = [];
    if (c.subOrderNum) tags.push(`<span class="claim-tag">Sub: ${c.subOrderNum}</span>`);
    if (c.packetId)    tags.push(`<span class="claim-tag">Pkt: ${c.packetId}</span>`);
    if (fileCount)     tags.push(`<span class="claim-tag files">${fileCount} file${fileCount > 1 ? 's' : ''}</span>`);

    return `
      <div class="claim-item${c.filled ? ' filled' : ''}">
        <div class="claim-header">
          <span class="claim-awb">${c.awb || '—'}</span>
          <span class="claim-time">${formatTime(c.receivedAt)}</span>
        </div>
        ${tags.length ? `<div class="claim-tags">${tags.join('')}</div>` : ''}
        <button class="btn btn-primary claim-fill-btn" data-claim-id="${c.claimId}">
          ${c.filled ? '✓ Filled — Fill Again' : 'Fill Form →'}
        </button>
      </div>
    `;
  }).join('');
}

async function fillClaim(claimId) {
  // Always use the freshest claim data from server
  const { token } = await new Promise(r => chrome.storage.local.get(['token'], r));
  let claim = currentClaims.find(c => c.claimId === claimId) || null;

  // If local copy missing or has no files, fetch from server
  if (!claim || !claim.files || !Object.keys(claim.files).length) {
    try {
      const res = await fetch(`${SERVER}/api/claims`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const all = await res.json();
        claim = all.find(c => c.claimId === claimId) || claim;
      }
    } catch { }
  }

  chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
    if (!tabs.length) {
      chrome.tabs.create({ url: 'https://supplier.meesho.com/returns' });
      chrome.storage.local.set({ pendingFillClaimId: claimId, pendingFillClaim: claim || null });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'fill_claim', claimId, claim: claim || null }, () => {
      if (chrome.runtime.lastError) {
        chrome.storage.local.set({ pendingFillClaimId: claimId, pendingFillClaim: claim || null });
        chrome.tabs.reload(tabs[0].id);
      }
    });
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.storage.local.get(['filledClaims'], ({ filledClaims = [] }) => {
      if (!filledClaims.includes(claimId)) {
        chrome.storage.local.set({ filledClaims: [...filledClaims, claimId] });
      }
    });
  });
}

function clearClaims() {
  chrome.storage.local.remove('filledClaims', () => {
    chrome.storage.local.get(['token'], ({ token }) => loadClaims(token));
  });
}

// ── Scan log ──────────────────────────────────────────────────────────────────

function renderLog(log) {
  const list = $('scanList');
  if (!log || !log.length) {
    list.innerHTML = '<div class="empty">No scans yet</div>';
    return;
  }
  list.innerHTML = log.slice(0, 30).map(s => `
    <div class="scan-item">
      <div>
        <div class="scan-awb">${s.awb}</div>
        <div class="scan-time">${formatTime(s.receivedAt || s.ts)}</div>
      </div>
      <span class="scan-badge received">Received</span>
    </div>
  `).join('');
}

function clearLog() {
  chrome.storage.local.remove('scanLog', () => renderLog([]));
}

// ── Manual search ─────────────────────────────────────────────────────────────

function manualSearch() {
  const awb = $('manualAWB').value.trim().toUpperCase();
  if (!awb) return;
  $('manualAWB').value = '';
  chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
    if (!tabs.length) {
      chrome.tabs.create({ url: 'https://supplier.meesho.com/returns' });
      chrome.storage.local.set({ pendingAWB: awb });
    } else {
      for (const tab of tabs)
        chrome.tabs.sendMessage(tab.id, { type: 'manual_scan', awb }).catch(() => {});
      chrome.tabs.update(tabs[0].id, { active: true });
    }
  });
}

// ── Event listeners ───────────────────────────────────────────────────────────

$('claimList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-claim-id]');
  if (btn) fillClaim(btn.dataset.claimId);
});

$('authBtn').addEventListener('click', submitAuth);
$('authToggle').addEventListener('click', toggleMode);
$('logoutBtn').addEventListener('click', logout);
$('clearLogBtn').addEventListener('click', clearLog);
$('clearClaimsBtn').addEventListener('click', clearClaims);
$('manualGoBtn').addEventListener('click', manualSearch);

$('openMeeshoBtn').addEventListener('click', () => {
  chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
    if (tabs.length) {
      chrome.tabs.reload(tabs[0].id);
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: 'https://supplier.meesho.com/returns' });
    }
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if ($('panelAuth').classList.contains('active')) submitAuth();
  else manualSearch();
});

// Refresh scan log live
chrome.storage.onChanged.addListener((changes) => {
  if (changes.scanLog) renderLog(changes.scanLog.newValue || []);
});

// Poll status + claims every 5 s while popup is open
setInterval(() => {
  chrome.storage.local.get(['token'], ({ token }) => {
    if (token) { refreshStatus(token); loadClaims(token); }
  });
}, 5000);

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['token', 'email'], (data) => {
  if (data.token && data.email) loadMainPanel();
  else showPanel('panelAuth');
});
