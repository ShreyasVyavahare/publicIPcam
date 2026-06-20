/**
 * IPCam Relay Server
 * ------------------
 * Receives JPEG frames from the browser (POST /push)
 * and serves them at GET /shot.jpg for any client.
 *
 * Setup:
 *   npm install express cors
 *   node relay.js
 *
 * Optional env vars:
 *   PORT=3000
 *   STREAM_KEY=mysecretkey   <- if set, push & fetch both require ?key=
 *   ALLOWED_IPS=192.168.1.0/24,10.0.0.1   <- comma-separated CIDR/IPs to whitelist (optional)
 */

const express  = require('express');
const cors     = require('cors');
const http     = require('http');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = process.env.PORT || 3001;
const STREAM_KEY   = process.env.STREAM_KEY   || '';
const ALLOWED_IPS  = (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);

// ── helpers ──────────────────────────────────────────────────────────────────

function ipAllowed(req) {
  if (ALLOWED_IPS.length === 0) return true;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '';
  // simple prefix match (covers exact IPs and naive CIDR-like ranges)
  return ALLOWED_IPS.some(allowed => ip.startsWith(allowed.replace(/\/\d+$/, '').replace(/\.\d+$/, '.')));
}

function keyOk(req) {
  if (!STREAM_KEY) return true;
  return req.query.key === STREAM_KEY || req.headers['x-stream-key'] === STREAM_KEY;
}

// ── middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — ${req.socket.remoteAddress}`);
  next();
});

// Serve ipcam.html at root
app.use(express.static(__dirname));

// ── state ─────────────────────────────────────────────────────────────────────

let latestFrame    = null;   // Buffer
let lastPushTime   = null;
let totalPushes    = 0;

// ── routes ────────────────────────────────────────────────────────────────────

/**
 * POST /push
 * Browser sends: { key?: string, frame: "data:image/jpeg;base64,..." }
 */
app.post('/push', express.json({ limit: '10mb' }), (req, res) => {
  try {
    console.log('POST /push received');

    if (!keyOk(req)) {
      console.log('Invalid stream key');
      return res.status(401).json({ error: 'Invalid stream key' });
    }

    const { frame } = req.body || {};

    if (!frame) {
      console.log('NO FRAME RECEIVED');
      return res.status(400).json({ error: 'Missing frame data' });
    }

    console.log('Frame prefix:', frame.substring(0, 50));

    // Accept jpeg/png/webp
    if (!frame.startsWith('data:image/')) {
      console.log('INVALID IMAGE FORMAT');
      return res.status(400).json({
        error: 'Expected data:image/*;base64,...'
      });
    }

    const parts = frame.split(',');

    if (parts.length < 2) {
      console.log('INVALID BASE64 FORMAT');
      return res.status(400).json({
        error: 'Malformed image data'
      });
    }

    latestFrame = Buffer.from(parts[1], 'base64');
    lastPushTime = new Date();
    totalPushes++;

    console.log(
      `FRAME ACCEPTED | size=${latestFrame.length} bytes | total=${totalPushes}`
    );

    res.json({
      ok: true,
      pushed: totalPushes
    });

  } catch (e) {
    console.error('PUSH ERROR:', e);
    res.status(500).json({
      error: e.message
    });
  }
});

/**
 * GET /shot.jpg
 * Returns the latest JPEG frame.
 * Requires ?key= if STREAM_KEY is set.
 * Supports ?ip_check=1 to enforce ALLOWED_IPS.
 */
app.get('/shot.jpg', (req, res) => {
  if (!keyOk(req)) {
    return res.status(401).type('text').send('401 Unauthorized — wrong key');
  }
  if (req.query.ip_check && !ipAllowed(req)) {
    return res.status(403).type('text').send('403 Forbidden — IP not allowed');
  }
  if (!latestFrame) {
    return res.status(503).type('text').send('503 No frame available yet — start the stream first');
  }

  const age = lastPushTime ? Math.round((Date.now() - lastPushTime) / 1000) : '?';
  res.set({
    'Content-Type':  'image/jpeg',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma':        'no-cache',
    'X-Frame-Age':   `${age}s`,
    'X-Total-Frames': totalPushes,
  });
  res.send(latestFrame);
});

/**
 * GET /status
 * Quick health-check / stats endpoint.
 */
app.get('/status', (req, res) => {
  res.json({
    running:     true,
    hasFrame:    !!latestFrame,
    lastPush:    lastPushTime,
    totalFrames: totalPushes,
    keyRequired: !!STREAM_KEY,
    ipWhitelist: ALLOWED_IPS.length > 0 ? ALLOWED_IPS : 'disabled',
  });
});

/**
 * GET /mjpeg
 * Bonus: continuous MJPEG stream (like an IP cam).
 * Open in VLC or any browser: http://YOUR_IP:3000/mjpeg?key=...
 */
app.get('/mjpeg', (req, res) => {
  if (!keyOk(req)) return res.status(401).send('Unauthorized');

  res.set({
    'Content-Type': 'multipart/x-mixed-replace; boundary=--ipcamframe',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const send = () => {
    if (!latestFrame) return;
    res.write('--ipcamframe\r\n');
    res.write('Content-Type: image/jpeg\r\n\r\n');
    res.write(latestFrame);
    res.write('\r\n');
  };

  const iv = setInterval(send, 200); // push at up to 5fps to clients

  req.on('close', () => {
    clearInterval(iv);
    console.log('[mjpeg] client disconnected');
  });
});

// ── start ─────────────────────────────────────────────────────────────────────

http.createServer(app).listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       IPCam Relay Server             ║');
  console.log(`  ║  Listening on  http://0.0.0.0:${PORT}   ║`);
  console.log(`  ║  shot.jpg  →   http://localhost:${PORT}/shot.jpg  ║`);
  console.log(`  ║  mjpeg     →   http://localhost:${PORT}/mjpeg     ║`);
  console.log(`  ║  status    →   http://localhost:${PORT}/status    ║`);
  console.log(`  ║  Key required: ${STREAM_KEY ? 'YES (' + STREAM_KEY + ')' : 'NO (open)'}  ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  console.log('  To expose over internet:');
  console.log('    npx localtunnel --port ' + PORT);
  console.log('    or: ngrok http ' + PORT);
  console.log('');
});
