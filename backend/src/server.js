const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');

const dbModule = require('./db');
const { loadSettings } = require('./settings');
const { initSignaling } = require('./signaling');
const authRouter = require('./auth').router;
const mockCloudRouter = require('./mockCloud').router;
const transferRouter = require('./transfer');
const { router: settingsRouter } = require('./settings');
const { router: billingRouter } = require('./billing');
const qrRouter = require('./qrRouter');
const { getLocalIpAddresses } = require('./utils/network');

/**
 * Initializes and spins up the AeroSync Server.
 * Configures REST API routes, static UI assets, and the WebSocket server.
 */
function startServer() {
  dbModule.initDb();
  const settings = loadSettings();
  const app = express();

  // Configure CORS for cross-device network flexibility
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id', 'x-upload-id', 'x-chunk-index', 'x-session-token']
  }));

  // Parse HTTP payloads
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Dynamic static asset mapping (serves the desktop UI once created)
  const frontendDir = path.join(process.cwd(), 'frontend');
  if (fs.existsSync(frontendDir)) {
    app.use(express.static(frontendDir));
  }

  // Connect backend sub-routers
  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/mock-cloud', mockCloudRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api', transferRouter);
  app.use('/api/transfer', transferRouter);
  app.use('/api/qr', qrRouter);

  // Serve join page
  app.get('/join', (req, res) => {
    res.sendFile(path.join(process.cwd(), 'frontend', 'index.html'));
  });

  // Serve public share token landing page
  app.get('/share/:token', (req, res) => {
    const { token } = req.params;
    const { db, saveDb } = require('./db');
    const fs = require('fs');
    const path = require('path');
    
    try {
      const share = db.share_tokens.find(s => s.token === token);
      if (!share) {
        return res.status(404).send('<html><body style="background:#0b0f19;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>This link has expired or is invalid.</h2></body></html>');
      }
      
      if (Date.now() > share.expires_at) {
        db.share_tokens = db.share_tokens.filter(s => s.token !== token);
        saveDb();
        return res.status(403).send('<html><body style="background:#0b0f19;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>This link has expired.</h2></body></html>');
      }
      
      const file = db.files.find(f => f.id === share.file_id);
      if (!file || file.status === 'pending') {
        return res.status(404).send('<html><body style="background:#0b0f19;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><h2>File not available.</h2></body></html>');
      }
      
      let iconClass = 'bi-file-earmark-fill';
      if (file.mimeType && file.mimeType.startsWith('image/')) iconClass = 'bi-file-earmark-image-fill';
      else if (file.mimeType && file.mimeType.startsWith('video/')) iconClass = 'bi-file-earmark-play-fill';
      else if (file.mimeType && file.mimeType.startsWith('audio/')) iconClass = 'bi-file-earmark-music-fill';
      else if (file.mimeType && (file.mimeType.includes('pdf') || file.name.endsWith('.pdf'))) iconClass = 'bi-file-earmark-pdf-fill';
      else if (file.mimeType && (file.mimeType.includes('zip') || file.mimeType.includes('compressed'))) iconClass = 'bi-file-earmark-zip-fill';
      
      const formatBytes = (bytes, decimals = 2) => {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
      };

      const btnHtml = share.permission === 'view'
        ? `<button class="btn btn-disabled" disabled><i class="bi bi-eye-slash-fill"></i> View Only Link (Download Disabled)</button>`
        : `<a href="/api/public/download/${token}" class="btn btn-primary" style="text-decoration: none;"><i class="bi bi-download"></i> Download File</a>`;

      const badgeHtml = share.permission === 'view'
        ? `<span class="badge badge-view"><i class="bi bi-eye-fill me-1"></i> View Only</span>`
        : `<span class="badge badge-download"><i class="bi bi-download me-1"></i> View & Download</span>`;

      const pageHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AeroSync Share - ${file.name}</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.5/font/bootstrap-icons.css">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(16, 22, 34, 0.7);
      --accent: #88c0d0;
      --accent-hover: #81a1c1;
      --border: 1px solid rgba(255,255,255,0.08);
      --text: #ffffff;
      --text-muted: rgba(255,255,255,0.6);
    }
    body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--text);
      font-family: 'Outfit', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      overflow: hidden;
      position: relative;
    }
    body::before {
      content: '';
      position: absolute;
      width: 300px;
      height: 300px;
      background: var(--accent);
      filter: blur(150px);
      opacity: 0.15;
      top: 10%;
      left: 10%;
      z-index: 0;
    }
    body::after {
      content: '';
      position: absolute;
      width: 300px;
      height: 300px;
      background: #81a1c1;
      filter: blur(150px);
      opacity: 0.15;
      bottom: 10%;
      right: 10%;
      z-index: 0;
    }
    .container {
      position: relative;
      z-index: 1;
      width: 90%;
      max-width: 440px;
    }
    .share-card {
      background: var(--card-bg);
      border: var(--border);
      border-radius: 16px;
      padding: 30px;
      backdrop-filter: blur(20px);
      box-shadow: 0 20px 50px rgba(0,0,0,0.5);
      text-align: center;
      transition: transform 0.3s ease, box-shadow 0.3s ease;
    }
    .share-card:hover {
      transform: translateY(-5px);
      box-shadow: 0 25px 60px rgba(0,0,0,0.6);
    }
    .logo-container {
      margin-bottom: 25px;
    }
    .logo {
      font-weight: 700;
      font-size: 20px;
      letter-spacing: 1px;
      color: #fff;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .logo i {
      color: var(--accent);
    }
    .file-icon {
      font-size: 64px;
      color: var(--accent);
      margin-bottom: 15px;
      display: block;
    }
    .file-name {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 8px 0;
      word-wrap: break-word;
      line-height: 1.4;
    }
    .file-size {
      font-size: 13px;
      color: var(--text-muted);
      margin-bottom: 25px;
      display: block;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 14px;
      cursor: pointer;
      transition: all 0.2s ease;
      box-sizing: border-box;
      font-family: inherit;
    }
    .btn-primary {
      background: var(--accent);
      border: none;
      color: #101622;
    }
    .btn-primary:hover {
      background: var(--accent-hover);
      transform: scale(1.02);
    }
    .btn-disabled {
      background: rgba(255,255,255,0.05);
      border: 1px dashed rgba(255,255,255,0.1);
      color: var(--text-muted);
      cursor: not-allowed;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      font-size: 10px;
      border-radius: 4px;
      font-weight: 600;
      margin-top: 15px;
    }
    .badge-view {
      background: rgba(136, 192, 208, 0.15);
      color: var(--accent);
    }
    .badge-download {
      background: rgba(163, 190, 140, 0.15);
      color: #a3be8c;
    }
    .expiry {
      font-size: 11px;
      color: rgba(255,255,255,0.4);
      margin-top: 20px;
      display: block;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="share-card">
      <div class="logo-container">
        <span class="logo"><i class="bi bi-clouds-fill"></i> AeroSync Share</span>
      </div>
      <i class="bi ${iconClass} file-icon"></i>
      <h3 class="file-name">${file.name}</h3>
      <span class="file-size">${formatBytes(file.size)}</span>
      
      ${btnHtml}
      ${badgeHtml}
      
      <span class="expiry"><i class="bi bi-clock me-1"></i> Link expires: ${new Date(share.expires_at).toLocaleString()}</span>
    </div>
  </div>
</body>
</html>
      `;
      res.send(pageHtml);
    } catch (err) {
      console.error(err);
      res.status(500).send('Server Error');
    }
  });

  // Default API ping response
  app.get('/api', (req, res) => {
    res.json({
      service: 'AeroSync File Transfer API',
      status: 'online',
      version: '1.0.0'
    });
  });

  const server = http.createServer(app);

  // Initialize the WebSocket signaling server on the same port
  initSignaling(server);

  const PORT = process.env.PORT || settings.port || 5000;

  server.listen(PORT, '0.0.0.0', () => {
    console.log('\n==================================================');
    console.log(` 🚀 AeroSync Server has started successfully!`);
    console.log(` 💻 Local Access: http://localhost:${PORT}`);

    // Fetch and print out local IP addresses for LAN network access
    const localIps = getLocalIpAddresses();
    if (localIps.length > 0) {
      console.log(' 🌐 Local Network (LAN) URLs:');
      localIps.forEach(ip => {
        console.log(`    - http://${ip.address}:${PORT}  (Interface: ${ip.interface} [${ip.type}])`);
      });
    } else {
      console.log(' 🌐 LAN Access: No active Wi-Fi/Ethernet connections detected.');
    }

    if (settings.enableTunnel) {
      const { startTunnel } = require('./utils/tunnel');
      startTunnel(PORT);
    }

    console.log(` 🔌 WebSocket WS:  ws://localhost:${PORT}/ws`);
    console.log(` 📁 Storage Path:  ${settings.sharedDirectory}`);
    console.log('==================================================\n');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ Error: Port ${PORT} is already in use by another process.`);
      console.error(`   Please edit settings.json to use a different port or free up port ${PORT}.\n`);
    } else {
      console.error('❌ Server startup error:', err.message);
    }
  });
}

// Auto-run when executed directly via Node
if (require.main === module) {
  startServer();
}

module.exports = { startServer };
