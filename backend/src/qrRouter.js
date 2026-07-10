const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { generateQRCode, generateQRCodeBuffer } = require('./utils/qr');
const { getActiveOTP, getOrCreateRoom } = require('./signaling');

// Helper to load current settings
function getSettings() {
  try {
    const settingsPath = path.join(process.cwd(), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch (err) {
    console.error('[Settings Load Error]', err);
  }
  return {};
}

/**
 * GET /api/qr/connection
 * Return dynamic connection data with active OTP, roomId, joinToken, and generated QR base64
 */
router.get('/connection', async (req, res) => {
  try {
    const settings = getSettings();
    const port = process.env.PORT || settings.port || 5000;
    const deviceName = settings.deviceName || os.hostname();

    const hostClientId = req.query.clientId || 'default';
    const room = getOrCreateRoom(hostClientId);
    const roomId = 'room_' + hostClientId;

    const origin = req.protocol + '://' + req.get('host');
    const joinURL = `${origin}/join?roomId=${roomId}&joinToken=${room.joinToken}`;
    
    // Generate QR code base64 URL
    const qrCodeBase64 = await generateQRCode(joinURL, { width: 300 });

    res.json({
      qrCode: qrCodeBase64,
      otp: room.otp,
      roomId: roomId,
      joinToken: room.joinToken,
      joinURL: joinURL,
      expiresIn: Math.max(0, Math.round((room.tokenExpiresAt - Date.now()) / 1000)),
      deviceName: deviceName
    });
  } catch (err) {
    console.error('Failed to get connection QR:', err);
    res.status(500).json({ error: 'Failed to generate connection QR' });
  }
});

/**
 * GET /api/qr/download
 * Download custom QR code as a PNG file attachment
 */
router.get('/download', async (req, res) => {
  try {
    const { data } = req.query;
    if (!data) {
      return res.status(400).json({ error: 'Missing query parameter: data' });
    }

    const buffer = await generateQRCodeBuffer(data, { width: 300 });
    res.setHeader('Content-Disposition', 'attachment; filename="aerosync_qr.png"');
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('Failed to download QR:', err);
    res.status(500).json({ error: 'Failed to generate download QR' });
  }
});

/**
 * GET /api/qr/generate
 * Stream a custom QR code image directly to the client
 */
router.get('/generate', async (req, res) => {
  try {
    const { data, size } = req.query;
    if (!data) {
      return res.status(400).json({ error: 'Missing query parameter: data' });
    }

    const width = parseInt(size, 10) || 300;
    const buffer = await generateQRCodeBuffer(data, { width });
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  } catch (err) {
    console.error('Failed to stream generated QR:', err);
    res.status(500).json({ error: 'Failed to stream QR' });
  }
});

module.exports = router;
