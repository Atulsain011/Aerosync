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
