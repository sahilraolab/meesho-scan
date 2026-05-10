'use strict';

// The server URL is stored in chrome.storage after first login.
// Default to the production URL. For dev, change this constant or update storage manually.
const DEFAULT_SERVER = 'https://scanserver.techseventeen.com';

let SERVER       = DEFAULT_SERVER;
let authMode     = 'login';
let currentClaims = [];

function $(id) { return document.getElementById(id); }

function showPanel(id) {
  $('panelAuth').classList.toggle('active', id === 'panelAuth');
  $('panelMain').classList.toggle('active', id === 'panelMain');
  if (id === 'panelAuth') $('authServer').value = SERVER;
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
  const serverInput = ($('authServer').value || '').trim().replace(/\/$/, '');
  if (serverInput) SERVER = serverInput;
  const email    = $('authEmail').value.trim();
  const password = $('authPassword').value;
  $('authErr').textContent = '';

  if (!SERVER)   { $('authErr').textContent = 'Server URL is required.'; return; }
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
    try { data = await res.json(); } catch { throw new Error(`Server error (${res.status})`); }
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
  const data = await chrome.storage.local.get(['token', 'email', 'serverUrl']);
  if (data.serverUrl) SERVER = data.serverUrl;
  $('userEmail').textContent = data.email || '';
  refreshStatus(data.token);
  loadClaims(data.token);
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
      s.mobileConnected ? 'Scanner: connected' : 'Scanner: not connected'
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
  badge.textContent   = pending.length || '';
  badge.style.display = pending.length ? 'inline-flex' : 'none';
  clearBtn.style.display = queue.some(c => c.filled) ? 'block' : 'none';

  list.innerHTML = queue.map(c => {
    const fileCount = Object.keys(c.files || {}).length;
    const tags = [];
    if (c.subOrderNum) tags.push(`<span class="claim-tag">Sub: ${c.subOrderNum}</span>`);
    if (c.packetId)    tags.push(`<span class="claim-tag">Pkt: ${c.packetId}</span>`);
    if (fileCount)     tags.push(`<span class="claim-tag files">${fileCount} file${fileCount > 1 ? 's' : ''}</span>`);

    const canFill = fileCount > 0;
    const btnStyle = canFill ? '' : 'opacity:0.5; pointer-events:none;';
    const btnTitle = canFill ? 'Fill Form on Meesho' : 'Add media first (from scanner app)';

    return `
      <div class="claim-item${c.filled ? ' filled' : ''}">
        <div class="claim-header">
          <span class="claim-awb">${c.awb || '—'}</span>
          <span class="claim-time">${formatTime(c.receivedAt)}</span>
        </div>
        ${tags.length ? `<div class="claim-tags">${tags.join('')}</div>` : '<div style="font-size:11px;color:var(--muted);margin-bottom:6px">⚠️ Add photos in scanner app first</div>'}
        <button class="claim-fill-btn" style="${btnStyle}" title="${btnTitle}" data-claim-id="${c.claimId}">
          ${c.filled ? '✓ Filled — Fill Again' : canFill ? 'Fill Meesho Form →' : '⚠️ No media attached'}
        </button>
      </div>
    `;
  }).join('');
}

async function fillClaim(claimId) {
  const { token } = await chrome.storage.local.get(['token']);
  let claim = currentClaims.find(c => c.claimId === claimId) || null;

  // Fetch fresh claim from server
  try {
    const res = await fetch(`${SERVER}/api/claim/${claimId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) claim = await res.json();
  } catch {}

  // Verify claim has media
  if (!claim?.files || Object.keys(claim.files).length === 0) {
    // Show temporary message
    const btn = document.querySelector(`[data-claim-id="${claimId}"]`);
    if (btn) {
      btn.textContent = '⚠️ Add photos in scanner app first';
      setTimeout(() => { btn.textContent = 'Fill Meesho Form →'; }, 3000);
    }
    return;
  }

  chrome.tabs.query({ url: 'https://supplier.meesho.com/*' }, (tabs) => {
    if (!tabs.length) {
      chrome.tabs.create({ url: 'https://supplier.meesho.com/returns' });
      chrome.storage.local.set({ pendingFillClaimId: claimId, pendingFillClaim: claim || null });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { type: 'fill_claim', claimId, claim: claim || null }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        // Content script not ready — save pending and reload the tab
        chrome.storage.local.set({ pendingFillClaimId: claimId, pendingFillClaim: claim || null });
        chrome.tabs.reload(tabs[0].id);
      } else {
        // Successfully delivered — mark as filled
        chrome.storage.local.get(['filledClaims'], ({ filledClaims = [] }) => {
          if (!filledClaims.includes(claimId)) {
            chrome.storage.local.set({ filledClaims: [...filledClaims, claimId] });
          }
        });
      }
    });
    chrome.tabs.update(tabs[0].id, { active: true });
  });
}

function clearClaims() {
  chrome.storage.local.remove('filledClaims', () => {
    chrome.storage.local.get(['token'], ({ token }) => loadClaims(token));
  });
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
$('clearClaimsBtn').addEventListener('click', clearClaims);
$('manualGoBtn').addEventListener('click', manualSearch);
$('manualAWB').addEventListener('keydown', (e) => { if (e.key === 'Enter') manualSearch(); });

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
});

// Poll status + claims every 6s while popup is open
setInterval(() => {
  chrome.storage.local.get(['token'], ({ token }) => {
    if (token) { refreshStatus(token); loadClaims(token); }
  });
}, 6000);

// ── Boot ──────────────────────────────────────────────────────────────────────

chrome.storage.local.get(['token', 'email', 'serverUrl'], (data) => {
  if (data.serverUrl) SERVER = data.serverUrl;
  if (data.token && data.email) loadMainPanel();
  else showPanel('panelAuth');
});