const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 8080;
const MEDIA_DIR = path.join(__dirname, 'media');

// Create media folder if missing
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR);

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR));

// API: List audio files in media folder
app.get('/api/media', (req, res) => {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .filter(f => /\.(mp3|wav|ogg|m4a|flac|aac|webm|opus)$/i.test(f))
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(MEDIA_DIR, f)).size
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

// API: Upload audio files
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

app.post('/api/upload', upload.array('files'), (req, res) => {
  res.json({ success: true, files: req.files.map(f => f.filename) });
});

// Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/client', (req, res) => res.sendFile(path.join(__dirname, 'public', 'client.html')));
app.get('/api/ip', (req, res) => res.json({ ip: getLocalIP(), port: PORT }));

// ========== Socket.IO ==========
let hostId = null;
let hostIp = null;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
        return alias.address;
    }
  }
  return '127.0.0.1';
}

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`[+] ${socket.id} (IP: ${clientIp})`);

  // === Host Registration ===
  socket.on('register-host', () => {
    hostId = socket.id;
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    hostIp = clientIp;
    console.log(`[HOST] Registered: ${hostId} (IP: ${hostIp})`);
    socket.emit('host-registered');
    socket.broadcast.emit('host-available');
  });

  // === Client Registration ===
  socket.on('register-client', () => {
    let clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
    if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim();

    console.log(`[CLIENT] Registered: ${socket.id} (IP: ${clientIp})`);

    // Strict IP Check (Fixed for Cloudflare/Render Proxies)
    if (hostIp && clientIp !== hostIp) {
      console.log(`[REJECT] Client ${socket.id} IP ${clientIp} doesn't match Host IP ${hostIp}`);
      socket.emit('network-error', 'Access Denied: You must be on the exact same Wi-Fi/Hotspot network as the Host.');
      socket.disconnect();
      return;
    }

    if (hostId) {
      io.to(hostId).emit('client-connected', socket.id);
    }
  });

  // === Sync Commands (Host -> Server -> All Clients) ===
  // Load/preload a file on all clients
  socket.on('sync-load', (data) => {
    console.log(`[SYNC] Load: ${data.file}`);
    socket.broadcast.emit('sync-load', data);
  });

  // Play at a specific position — server stamps current time for sync
  socket.on('sync-play', (data) => {
    data.serverTime = Date.now();
    console.log(`[SYNC] Play: ${data.file} @ ${data.position}s`);
    socket.broadcast.emit('sync-play', data);
  });

  // Pause — just relay current position
  socket.on('sync-pause', (data) => {
    console.log(`[SYNC] Pause @ ${data.position}s`);
    socket.broadcast.emit('sync-pause', data);
  });

  // Resume — server stamps time for sync
  socket.on('sync-resume', (data) => {
    data.serverTime = Date.now();
    console.log(`[SYNC] Resume @ ${data.position}s`);
    socket.broadcast.emit('sync-resume', data);
  });

  // Stop
  socket.on('sync-stop', () => {
    if (socket.id === hostId) {
      socket.broadcast.emit('sync-stop');
    }
  });

  // Seek to position
  socket.on('sync-seek', (data) => {
    data.serverTime = Date.now();
    console.log(`[SYNC] Seek @ ${data.position}s`);
    socket.broadcast.emit('sync-seek', data);
  });

  // Force Sync (WebRTC Latency Fix)
  socket.on('force-sync', () => {
    console.log(`[SYNC] Force Sync requested by Host`);
    socket.broadcast.emit('force-sync');
  });

  // === Time Sync (NTP-like for accurate sync) ===
  socket.on('time-sync-request', (data) => {
    socket.emit('time-sync-response', {
      clientSendTime: data.clientSendTime,
      serverTime: Date.now()
    });
  });

  // === WebRTC Signaling (Tab Capture Mode) ===
  socket.on('webrtc-offer', (data) => {
    // console.log(`[SIGNAL] Offer: ${socket.id} -> ${data.to}`);
    io.to(data.to).emit('webrtc-offer', {
      from: socket.id,
      offer: data.offer
    });
  });

  socket.on('webrtc-answer', (data) => {
    // console.log(`[SIGNAL] Answer: ${socket.id} -> ${data.to}`);
    io.to(data.to).emit('webrtc-answer', {
      from: socket.id,
      answer: data.answer
    });
  });

  socket.on('ice-candidate', (data) => {
    io.to(data.to).emit('ice-candidate', {
      from: socket.id,
      candidate: data.candidate
    });
  });

  // === Disconnect ===
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    if (socket.id === hostId) {
      hostId = null;
      console.log('[HOST] Disconnected');
      socket.broadcast.emit('host-disconnected');
      socket.broadcast.emit('sync-stop');
    } else if (hostId) {
      io.to(hostId).emit('client-disconnected', socket.id);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`  ║       SYNC AUDIO SERVER RUNNING      ║`);
  console.log(`  ╠══════════════════════════════════════╣`);
  console.log(`  ║  Host:      http://localhost:${PORT}       ║`);
  console.log(`  ║  Mobile DJ: http://${ip}:${PORT}/mobile  ║`);
  console.log(`  ║  Client:    http://${ip}:${PORT}/client  ║`);
  console.log(`  ║  Media:     ./media/ folder              ║`);
  console.log(`  ╚══════════════════════════════════════╝\n`);
});
