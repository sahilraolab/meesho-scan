# Meesho Scan v2 — Return Verification Tool

Scan AWB barcodes on your phone/desktop, auto-search Meesho Returns via the Chrome extension, detect wrong items, create claims, and file them — all in one workflow.

---

## Architecture

```
[Scanner App (Web)]  ←WebSocket→  [Node Server]  ←WebSocket→  [Chrome Extension]
     (mobile/desktop)                (relay)               (supplier.meesho.com)
```

- **Scanner App** — runs at your server URL (e.g. `https://scanserver.techseventeen.com`)
- **Server** — Node.js + WebSocket relay + REST API + NeDB (file-based DB)
- **Chrome Extension** — injected into `supplier.meesho.com`, receives scans, fills forms

---

## Setup

### 1. Server

```bash
cd server
cp .env.example .env
# Edit .env — set JWT_SECRET to a random 64-char string
npm install
npm start
```

Or with PM2:
```bash
pm2 start ecosystem.config.js
pm2 save
```

### 2. Chrome Extension

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select the `extension/` folder
4. Pin the extension from the toolbar

### 3. Scan App

Open `https://your-server-url` on any device (phone or desktop Chrome).  
Log in with the same account as the extension.

---

## Workflow

### Scanning

1. Open the scanner app → **Scan AWB** screen
2. Choose mode:
   - **Camera** — uses webcam / phone camera with QuaggaJS
   - **Barcode Scanner / USB** — connect USB/Bluetooth barcode gun, focus field, scan
   - **Manual** — type AWB manually
3. Scan an AWB → sent to extension via WebSocket
4. Extension auto-searches on Meesho Returns, extracts Sub Order ID
5. A modal appears with AWB + Sub Order ID and three options:
   - **✓ OK** — dismiss, scan next
   - **⏭ Skip** — mark as skipped, add to history, scan next
   - **⚠️ Wrong Item** — open Add Claim flow

### Wrong Item → Add Claim

1. Step 1: Verify info (AWB + Sub Order ID pre-filled)
2. Step 2: Scan Packet ID barcode (camera or scanner gun)
3. Step 3: Confirm and save — claim saved with **Pending** status + 7-day countdown
4. Returns to Scan AWB screen automatically

### Filing Claims

1. Go to **Claims** screen
2. Click any claim to open detail
3. Attach required media:
   - 📷 Barcode image
   - 🖼️ Product image  
   - 📄 Reverse waybill
   - 🎥 Unboxing video
4. Click **File Claim via Extension** — extension opens Meesho Returns form and auto-fills it

---

## Features

- **Multi-mode barcode scanning**: Camera (QuaggaJS), USB/Bluetooth scanner gun, manual
- **Real-time WebSocket relay** between app and extension
- **Automatic sub-order extraction** from Meesho Returns table
- **7-day claim window indicator** with color-coded urgency
- **Skip scan** — adds to history without creating claim
- **Floating extension UI** on Meesho tab — click the indicator bubble to see status + claims without opening popup
- **Desktop-first UI** with responsive mobile support
- **Claims require media** before filing — enforced in both extension popup and app
- **Scan history** with status tracking (scanned / delivered / skipped / claimed)
- **Dashboard** at `/dashboard` for server-side reporting

---

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `PORT` | Server port | `3847` |
| `JWT_SECRET` | Secret for JWT signing | auto-generated |
| `DATA_DIR` | Path for DB + uploads | `./data` |
| `ALLOWED_ORIGINS` | Comma-separated CORS origins | techseventeen domains |

---

## File Structure

```
meesho-scan/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js        # Injected into supplier.meesho.com
│   ├── popup.html/js/css # Extension popup UI
│   └── icons/
├── server/
│   ├── index.js          # Express + WebSocket server
│   ├── dashboard.html    # Admin dashboard
│   ├── mobile/
│   │   └── index.html    # Scanner web app
│   ├── data/             # NeDB databases + uploads (auto-created)
│   ├── package.json
│   └── .env.example
└── ecosystem.config.js   # PM2 config
```
