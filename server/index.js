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

// ── Database (pure JS, no native compilation, just files on disk) ─────────────

const DATA_DIR   = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const users = new Datastore({ filename: path.join(DATA_DIR, 'users.db'), autoload: true });
const scans = new Datastore({ filename: path.join(DATA_DIR, 'scans.db'), autoload: true });

// ── Claim registry (persisted to disk) ───────────────────────────────────────

const CLAIMS_FILE = path.join(DATA_DIR, 'claims.json');

const claimRegistry = new Map();
const claimStore    = new Map();

// Load persisted claims on startup
try {
  const saved = JSON.parse(fs.readFileSync(CLAIMS_FILE, 'utf8'));
  for (const c of saved) {
    claimRegistry.set(c.claimId, c.email);
    claimStore.set(c.claimId, c);
  }
  console.log(`[Claims] loaded ${saved.length} claims from disk`);
} catch { /* file doesn't exist yet — fine */ }

function persistClaims() {
  fs.writeFile(CLAIMS_FILE, JSON.stringify([...claimStore.values()], null, 2), () => {});
}

// Multer: disk storage keyed by claimId set before upload runs
const claimStorage = multer.diskStorage({
  destination: (req, _f, cb) => cb(null, path.join(UPLOAD_DIR, req.claimId)),
  filename:    (_r, f,  cb) => cb(null, f.fieldname + path.extname(f.originalname || '.bin')),
});
const upload = multer({
  storage: claimStorage,
  limits:  { fileSize: 25 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    console.log(`[multer] field=${file.fieldname} mime=${file.mimetype} size-hint=${file.size}`);
    if (file.fieldname === 'unpacking_video') {
      const ok = /^video\//i.test(file.mimetype);
      console.log(`[multer] video accept=${ok}`);
      return cb(null, ok);
    }
    cb(null, /^image\//i.test(file.mimetype));
  },
});
function assignClaimId(req, _res, next) {
  req.claimId = crypto.randomUUID();
  fs.mkdirSync(path.join(UPLOAD_DIR, req.claimId), { recursive: true });
  next();
}

users.ensureIndex({ fieldName: 'email', unique: true });
scans.ensureIndex({ fieldName: 'email' });

console.log(`[DB] ${DATA_DIR}`);

// ── Express ───────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use(cors({
  origin: [
    'https://meesho.techseventeen.com',
    'https://scanserver.techseventeen.com',
  ],
  credentials: true,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'mobile')));
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'mobile', 'index.html')));

app.get('/extension.zip', (req, res) => {
  const zipPath = path.join(__dirname, 'extension.zip');
  if (!fs.existsSync(zipPath)) return res.status(404).send('Extension ZIP not found.');
  res.download(zipPath, 'meesho-scan-extension.zip');
});

// ── Auth ──────────────────────────────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required.' });
    if (await users.findOneAsync({ email }))
      return res.status(409).json({ error: 'Account already exists.' });

    await users.insertAsync({ email, hash: await bcrypt.hash(password, 10) });
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

// ── API ───────────────────────────────────────────────────────────────────────

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Unauthorized.' }); }
}

app.get('/api/status', auth, (req, res) => {
  const conn = connections.get(req.user.email) || {};
  res.json({
    extensionConnected: conn.extension?.readyState === WebSocket.OPEN,
    mobileConnected:    conn.mobile?.readyState    === WebSocket.OPEN,
  });
});

app.get('/api/logs', auth, async (req, res) => {
  try {
    const logs = await scans.find({ email: req.user.email })
      .sort({ ts: -1 }).limit(50).execAsync();
    res.json(logs.map(({ awb, ts, status }) => ({ awb, ts, status })));
  } catch {
    res.status(500).json({ error: 'Server error.' });
  }
});

// ── Claim upload ──────────────────────────────────────────────────────────────

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
}, (req, res) => {
  const { subOrderNum, awb, packetId } = req.body || {};
  const claimId = req.claimId;

  // Enforce per-type size limits (images ≤ 5 MB, video already capped by multer at 25 MB)
  for (const [field, arr] of Object.entries(req.files || {})) {
    if (field !== 'unpacking_video' && arr[0].size > 5 * 1024 * 1024) {
      fs.rm(path.join(UPLOAD_DIR, claimId), { recursive: true, force: true }, () => {});
      return res.status(413).json({ error: `${field} exceeds 5 MB limit.` });
    }
  }

  // Build file manifest
  const files = {};
  for (const key of Object.keys(req.files || {})) files[key] = true;

  // Register claim ownership + full metadata
  claimRegistry.set(claimId, req.user.email);
  claimStore.set(claimId, { email: req.user.email, claimId, awb, subOrderNum, packetId, files, ts: Date.now() });
  persistClaims();

  // Relay to extension
  const conn = getConn(req.user.email);
  let delivered = false;
  if (conn.extension?.readyState === WebSocket.OPEN) {
    conn.extension.send(JSON.stringify({ type: 'claim', claimId, subOrderNum, awb, packetId, files }));
    delivered = true;
  }

  res.json({ ok: true, claimId, delivered });
  console.log(`[CLAIM] ${req.user.email}: ${awb} → delivered=${delivered}`);
});

// List all pending claims for the authenticated user
app.get('/api/claims', auth, (req, res) => {
  const result = [];
  for (const c of claimStore.values()) {
    if (c.email === req.user.email) result.push(c);
  }
  result.sort((a, b) => b.ts - a.ts);
  res.json(result);
});

// Serve a single claim file to the extension (authenticated, ownership-checked)
app.get('/api/claim/:claimId/:field', auth, (req, res) => {
  const { claimId, field } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(claimId) || !/^[a-z_]+$/.test(field))
    return res.status(400).end();
  if (claimRegistry.get(claimId) !== req.user.email)
    return res.status(403).end();
  const dir = path.join(UPLOAD_DIR, claimId);
  try {
    const match = fs.readdirSync(dir).find(f => f.startsWith(field + '.'));
    if (!match) return res.status(404).end();
    const filePath = path.resolve(dir, match);
    console.log('[CLAIM FILE] serving:', filePath);
    res.sendFile(filePath);
  } catch {
    res.status(404).end();
  }
});

// ── WebSocket relay ───────────────────────────────────────────────────────────

const wss         = new WebSocketServer({ server });
const connections = new Map();

function getConn(email) {
  if (!connections.has(email)) connections.set(email, { mobile: null, extension: null });
  return connections.get(email);
}

wss.on('connection', (ws, req) => {
  console.log(`[WS] new connection from ${req.socket.remoteAddress}`);
  let email = null;
  let role  = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      try {
        const p = jwt.verify(msg.token, SECRET);
        email = p.email;
        role  = msg.role === 'extension' ? 'extension' : 'mobile';

        const conn = getConn(email);
        if (conn[role]?.readyState === WebSocket.OPEN) {
          conn[role].send(JSON.stringify({ type: 'session_replaced' }));
          conn[role].close();
        }
        conn[role] = ws;

        ws.send(JSON.stringify({ type: 'auth_ok', email }));
        console.log(`[WS] ${role} connected: ${email}`);

        const otherRole = role === 'mobile' ? 'extension' : 'mobile';
        const other = conn[otherRole];
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

    if (msg.type === 'scan' && role === 'mobile') {
      const awb = (msg.awb || '').trim().toUpperCase();
      if (!awb) return;
      const ts = Date.now();

      await scans.insertAsync({ email, awb, ts, status: 'scanned' });

      const conn = getConn(email);
      let delivered = false;
      if (conn.extension?.readyState === WebSocket.OPEN) {
        conn.extension.send(JSON.stringify({ type: 'scan', awb, ts }));
        delivered = true;
        await scans.updateAsync({ email, awb, ts }, { $set: { status: 'delivered' } }, {});
      }

      ws.send(JSON.stringify({ type: 'scan_ack', awb, delivered, ts }));
      console.log(`[SCAN] ${email}: ${awb} → delivered=${delivered}`);
    }
  });

  ws.on('close', () => {
    if (!email || !role) return;
    const conn = connections.get(email);
    if (conn?.[role] !== ws) return;
    conn[role] = null;
    const other = role === 'mobile' ? conn.extension : conn.mobile;
    if (other?.readyState === WebSocket.OPEN)
      other.send(JSON.stringify({ type: 'peer_disconnected', role }));
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 Meesho Scan Server on port ${PORT}\n`);
});