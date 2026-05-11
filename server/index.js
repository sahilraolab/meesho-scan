'use strict';

require('dotenv').config();

const express   = require('express');
const http      = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');
const multer    = require('multer');
const Datastore = require('@seald-io/nedb');

const PORT   = process.env.PORT || 3847;
const SECRET = process.env.JWT_SECRET || (() => {
  const f = path.join(__dirname, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(f, s); } catch {}
  return s;
})();

// ── Database ──────────────────────────────────────────────────────────────────

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const users  = new Datastore({ filename: path.join(DATA_DIR, 'users.db'),  autoload: true });
const scans  = new Datastore({ filename: path.join(DATA_DIR, 'scans.db'),  autoload: true });
const claims = new Datastore({ filename: path.join(DATA_DIR, 'claims.db'), autoload: true });

users.ensureIndex({ fieldName: 'email', unique: true });
scans.ensureIndex({ fieldName: 'email' });
scans.ensureIndex({ fieldName: 'ts' });
claims.ensureIndex({ fieldName: 'email' });

console.log(`[DB] ${DATA_DIR}`);

// ── Multer ────────────────────────────────────────────────────────────────────

const claimStorage = multer.diskStorage({
  destination: (req, _f, cb) => cb(null, path.join(UPLOAD_DIR, req.claimId)),
  filename:    (_r, f, cb)  => cb(null, f.fieldname + path.extname(f.originalname || '.bin')),
});
const upload = multer({
  storage: claimStorage,
  limits:  { fileSize: 50 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.fieldname === 'unpacking_video') return cb(null, /^video\//i.test(file.mimetype));
    cb(null, /^image\//i.test(file.mimetype));
  },
});
function assignClaimId(req, _res, next) {
  req.claimId = crypto.randomUUID();
  fs.mkdirSync(path.join(UPLOAD_DIR, req.claimId), { recursive: true });
  next();
}

// ── Express ───────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// Build allowed origins — always include production domains + any extras from env
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = [
  'https://meesho.techseventeen.com',
  'https://scanserver.techseventeen.com',
  'https://supplier.meesho.com',
  ...EXTRA_ORIGINS,
];

app.use(cors({
  origin(origin, cb) {
    // Allow no-origin requests (native apps, curl, Postman)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    // Allow Chrome extensions
    if (/^chrome-extension:\/\//.test(origin)) return cb(null, true);
    // Allow localhost for development
    if (/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'mobile')));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'mobile', 'index.html')));

app.get('/dashboard', auth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/extension.zip', (_req, res) => {
  const zipPath = path.join(__dirname, 'extension.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('Extension ZIP not found.');
  res.download(zipPath, 'meesho-scan-extension.zip');
});

// Health check
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Auth middleware ───────────────────────────────────────────────────────────

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
  // Also accept token as a query param (used for <img src> tags where headers can't be set)
  const token  = bearer || (req.query.token || '').trim();
  if (!token) return res.status(401).json({ error: 'Unauthorized.' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized.' });
  }
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    if (await users.findOneAsync({ email })) return res.status(409).json({ error: 'Account already exists.' });

    await users.insertAsync({ email, hash: await bcrypt.hash(password, 10), createdAt: Date.now() });
    res.json({ token: jwt.sign({ email }, SECRET, { expiresIn: '30d' }), email });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await users.findOneAsync({ email });
    if (!user || !(await bcrypt.compare(password, user.hash)))
      return res.status(401).json({ error: 'Invalid email or password.' });
    res.json({ token: jwt.sign({ email }, SECRET, { expiresIn: '30d' }), email });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── API routes ────────────────────────────────────────────────────────────────

app.get('/api/status', auth, (req, res) => {
  const conn = connections.get(req.user.email) || {};
  res.json({
    extensionConnected: conn.extension?.readyState === WebSocket.OPEN,
    mobileConnected:    conn.mobile?.readyState    === WebSocket.OPEN,
  });
});

app.get('/api/logs', auth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const logs  = await scans.find({ email: req.user.email })
      .sort({ ts: -1 }).skip((page - 1) * limit).limit(limit).execAsync();
    res.json(logs);
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.post('/api/scan/skip', auth, async (req, res) => {
  try {
    const { awb, reason } = req.body || {};
    if (!awb) return res.status(400).json({ error: 'AWB required.' });
    await scans.insertAsync({
      email: req.user.email, awb, ts: Date.now(),
      status: 'skipped', reason: reason || 'user_skipped',
    });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Claims ────────────────────────────────────────────────────────────────────

app.post('/api/claim', auth, assignClaimId, (req, res, next) => {
  upload.fields([
    { name: 'barcode_image',   maxCount: 1 },
    { name: 'product_image',   maxCount: 1 },
    { name: 'reverse_waybill', maxCount: 1 },
    { name: 'unpacking_video', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      fs.rm(path.join(UPLOAD_DIR, req.claimId), { recursive: true, force: true }, () => {});
      return res.status(413).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const { subOrderNum, awb, packetId, scanId } = req.body || {};
  const claimId = req.claimId;

  for (const [field, arr] of Object.entries(req.files || {})) {
    if (field !== 'unpacking_video' && arr[0].size > 10 * 1024 * 1024) {
      fs.rm(path.join(UPLOAD_DIR, claimId), { recursive: true, force: true }, () => {});
      return res.status(413).json({ error: `${field} exceeds 10 MB limit.` });
    }
  }

  const files = {};
  for (const key of Object.keys(req.files || {})) files[key] = true;

  await claims.insertAsync({
    email: req.user.email, claimId, awb, subOrderNum,
    packetId, scanId: scanId || null, files,
    ts: Date.now(), status: 'pending', type: 'wrong_item', claimWindowDays: 7,
  });

  if (scanId) {
    await scans.updateAsync({ _id: scanId, email: req.user.email }, { $set: { claimed: true, claimId } }, {});
  }

  const conn = getConn(req.user.email);
  let delivered = false;
  if (conn.extension?.readyState === WebSocket.OPEN) {
    conn.extension.send(JSON.stringify({ type: 'claim', claimId, subOrderNum, awb, packetId, files }));
    delivered = true;
  }

  res.json({ ok: true, claimId, delivered });
  console.log(`[CLAIM] ${req.user.email}: ${awb} → delivered=${delivered}`);
});

// Create pending claim without media (wrong-item flow)
app.post('/api/claim/wrong-item', auth, async (req, res) => {
  try {
    const { awb, subOrderNum, packetId, scanId, claimType, packetState } = req.body || {};
    if (!awb) return res.status(400).json({ error: 'AWB is required.' });

    const claimId = crypto.randomUUID();
    await claims.insertAsync({
      email: req.user.email, claimId, awb,
      subOrderNum: subOrderNum || '', packetId: packetId || '',
      scanId: scanId || null, files: {}, ts: Date.now(),
      status: 'pending', type: 'wrong_item', claimWindowDays: 7,
      claimType: claimType || 'wrong_return',
      packetState: packetState || 'intact',
    });

    if (scanId) {
      await scans.updateAsync({ _id: scanId, email: req.user.email }, { $set: { claimed: true, claimId } }, {});
    }

    const conn = getConn(req.user.email);
    let delivered = false;
    if (conn.extension?.readyState === WebSocket.OPEN) {
      conn.extension.send(JSON.stringify({
        type: 'claim', claimId, subOrderNum, awb, packetId, files: {},
        claimType: claimType || 'wrong_return',
        packetState: packetState || 'intact',
      }));
      delivered = true;
    }

    res.json({ ok: true, claimId, delivered });
  } catch (err) {
    console.error('[wrong-item claim]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Upload / replace media files on an existing pending claim
app.post('/api/claim/:claimId/media', auth, async (req, res, next) => {
  const { claimId } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(claimId)) return res.status(400).end();
  try {
    const claim = await claims.findOneAsync({ claimId, email: req.user.email });
    if (!claim) return res.status(403).json({ error: 'Claim not found.' });
    req.claimId = claimId;
    fs.mkdirSync(path.join(UPLOAD_DIR, claimId), { recursive: true });
    next();
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
}, upload.fields([
  { name: 'barcode_image',   maxCount: 1 },
  { name: 'product_image',   maxCount: 1 },
  { name: 'reverse_waybill', maxCount: 1 },
  { name: 'unpacking_video', maxCount: 1 },
]), async (req, res) => {
  const { claimId } = req.params;
  try {
    const existing = await claims.findOneAsync({ claimId, email: req.user.email });
    const files = { ...(existing?.files || {}) };
    for (const key of Object.keys(req.files || {})) files[key] = true;

    await claims.updateAsync({ claimId, email: req.user.email }, { $set: { files } }, {});

    // Relay updated claim to extension
    const conn = getConn(req.user.email);
    if (conn.extension?.readyState === WebSocket.OPEN) {
      const updated = await claims.findOneAsync({ claimId });
      conn.extension.send(JSON.stringify({ type: 'claim', ...updated }));
    }

    res.json({ ok: true, files });
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.patch('/api/claim/:claimId/packet', auth, async (req, res) => {
  try {
    const { claimId } = req.params;
    const { packetId } = req.body || {};
    const claim = await claims.findOneAsync({ claimId, email: req.user.email });
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });
    await claims.updateAsync({ claimId, email: req.user.email }, { $set: { packetId: packetId || '' } }, {});
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/claims', auth, async (req, res) => {
  try {
    const result = await claims.findAsync({ email: req.user.email });
    result.sort((a, b) => b.ts - a.ts);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/claim/:claimId', auth, async (req, res) => {
  try {
    const claim = await claims.findOneAsync({ claimId: req.params.claimId, email: req.user.email });
    if (!claim) return res.status(404).json({ error: 'Not found.' });
    res.json(claim);
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

// Relay an existing claim to the extension via WebSocket (triggered from mobile "File Claim" button)
app.post('/api/claim/:claimId/relay', auth, async (req, res) => {
  try {
    const claim = await claims.findOneAsync({ claimId: req.params.claimId, email: req.user.email });
    if (!claim) return res.status(404).json({ error: 'Claim not found.' });

    const conn = getConn(req.user.email);
    let delivered = false;
    if (conn.extension?.readyState === WebSocket.OPEN) {
      conn.extension.send(JSON.stringify({
        type: 'claim',
        claimId: claim.claimId,
        awb: claim.awb,
        subOrderNum: claim.subOrderNum,
        packetId: claim.packetId,
        files: claim.files,
        claimType: claim.claimType || 'wrong_return',
        packetState: claim.packetState || 'intact',
      }));
      delivered = true;
    }
    res.json({ ok: true, delivered });
  } catch (err) {
    console.error('[relay claim]', err);
    res.status(500).json({ error: 'Server error.' });
  }
});

// Serve a single claim media file
app.get('/api/claim/:claimId/:field', auth, async (req, res) => {
  const { claimId, field } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(claimId) || !/^[a-z_]+$/.test(field)) return res.status(400).end();
  try {
    const claim = await claims.findOneAsync({ claimId, email: req.user.email });
    if (!claim) return res.status(403).end();
    const dir = path.join(UPLOAD_DIR, claimId);
    if (!fs.existsSync(dir)) return res.status(404).end();
    const match = fs.readdirSync(dir).find(f => f.startsWith(field + '.'));
    if (!match) return res.status(404).end();
    res.sendFile(path.resolve(dir, match));
  } catch {
    res.status(404).end();
  }
});

app.get('/api/reports/scans', auth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const query = { email: req.user.email };
    if (start || end) {
      query.ts = {};
      if (start) query.ts.$gte = parseInt(start);
      if (end)   query.ts.$lte = parseInt(end);
    }
    const data      = await scans.findAsync(query);
    const total     = data.length;
    const skipped   = data.filter(s => s.status === 'skipped').length;
    const delivered = data.filter(s => s.status === 'delivered').length;
    const claimed   = data.filter(s => s.claimed).length;
    const byDate    = {};
    data.forEach(s => {
      const date = new Date(s.ts).toISOString().split('T')[0];
      if (!byDate[date]) byDate[date] = { total: 0, delivered: 0, skipped: 0, claimed: 0 };
      byDate[date].total++;
      if (s.status === 'delivered') byDate[date].delivered++;
      if (s.status === 'skipped')   byDate[date].skipped++;
      if (s.claimed)                byDate[date].claimed++;
    });
    res.json({ total, delivered, skipped, claimed, byDate });
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

app.get('/api/reports/claims', auth, async (req, res) => {
  try {
    const data    = await claims.findAsync({ email: req.user.email });
    const total   = data.length;
    const pending = data.filter(c => c.status === 'pending').length;
    res.json({ total, pending, processed: total - pending, claims: data.sort((a, b) => b.ts - a.ts) });
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── WebSocket relay ───────────────────────────────────────────────────────────

const wss         = new WebSocketServer({ server });
const connections = new Map();

function getConn(email) {
  if (!connections.has(email)) connections.set(email, { mobile: null, extension: null });
  return connections.get(email);
}

wss.on('connection', (ws) => {
  let email = null;
  let role  = null;

  // Keepalive ping — prevents Nginx/cloud proxies from dropping idle WS connections
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 25000);

  ws.on('pong', () => { /* alive */ });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Auth ────────────────────────────────────────────────────────────────
    if (msg.type === 'auth') {
      try {
        const p = jwt.verify(msg.token, SECRET);
        email = p.email;
        role  = msg.role === 'extension' ? 'extension' : 'mobile';

        const conn = getConn(email);

        // Replace any existing same-role socket
        if (conn[role] && conn[role] !== ws && conn[role].readyState === WebSocket.OPEN) {
          conn[role].send(JSON.stringify({ type: 'session_replaced' }));
          conn[role].close();
        }
        conn[role] = ws;

        ws.send(JSON.stringify({ type: 'auth_ok', email }));
        console.log(`[WS] ${role} connected: ${email}`);

        // Notify peer and let this client know if peer is already connected
        const otherRole = role === 'mobile' ? 'extension' : 'mobile';
        const other     = conn[otherRole];
        if (other?.readyState === WebSocket.OPEN) {
          other.send(JSON.stringify({ type: 'peer_connected', role }));
          ws.send(JSON.stringify({ type: 'peer_connected', role: otherRole }));
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid token.' }));
      }
      return;
    }

    if (!email) return;

    // ── Scan (mobile → extension) ────────────────────────────────────────────
    if (msg.type === 'scan' && role === 'mobile') {
      const awb = (msg.awb || '').trim().toUpperCase();
      if (!awb) return;
      const ts = Date.now();

      const scanDoc = await scans.insertAsync({ email, awb, ts, status: 'scanned', claimed: false });
      const scanId  = scanDoc._id;

      const conn = getConn(email);
      let delivered = false;
      if (conn.extension?.readyState === WebSocket.OPEN) {
        conn.extension.send(JSON.stringify({ type: 'scan', awb, ts, scanId }));
        delivered = true;
        await scans.updateAsync({ _id: scanId }, { $set: { status: 'delivered' } }, {});
      }

      ws.send(JSON.stringify({ type: 'scan_ack', awb, delivered, ts, scanId }));
      console.log(`[SCAN] ${email}: ${awb} → delivered=${delivered}`);
    }

    // ── Sub-order found (extension → mobile) ────────────────────────────────
    if (msg.type === 'suborder_found' && role === 'extension') {
      const { awb, subOrderId, scanId } = msg;
      console.log(`[SUBORDER] ${awb} → ${subOrderId || 'null'}`);
      const conn = getConn(email);
      if (conn.mobile?.readyState === WebSocket.OPEN) {
        conn.mobile.send(JSON.stringify({ type: 'suborder_found', awb, subOrderId, scanId }));
      }
    }

    // ── Scan verified OK (extension → mobile) ───────────────────────────────
    if (msg.type === 'scan_ok' && role === 'extension') {
      const { awb, scanId } = msg;
      if (scanId) await scans.updateAsync({ _id: scanId }, { $set: { status: 'verified_ok' } }, {});
      const conn = getConn(email);
      if (conn.mobile?.readyState === WebSocket.OPEN) {
        conn.mobile.send(JSON.stringify({ type: 'scan_ok', awb, scanId }));
      }
    }
  });

  ws.on('close', () => {
    clearInterval(pingInterval);
    if (!email || !role) return;
    const conn = connections.get(email);
    if (!conn || conn[role] !== ws) return;
    conn[role] = null;
    console.log(`[WS] ${role} disconnected: ${email}`);
    const other = role === 'mobile' ? conn.extension : conn.mobile;
    if (other?.readyState === WebSocket.OPEN)
      other.send(JSON.stringify({ type: 'peer_disconnected', role }));
  });

  ws.on('error', (err) => {
    console.error(`[WS] error ${email}/${role}:`, err.message);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Meesho Scan Server — port ${PORT}`);
  console.log(`   CORS origins: ${ALLOWED_ORIGINS.join(', ')}\n`);
});