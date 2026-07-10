const QRCode = require('qrcode');
const os = require('os');
const { getLocalIpAddresses } = require('./network');

/**
 * Generate QR Code as Data URL (PNG)
 * @param {string} data - Data to encode in QR
 * @param {Object} options - QR Code options
 * @returns {Promise<string>} - Data URL of QR code
 */
async function generateQRCode(data, options = {}) {
  try {
    const defaultOptions = {
      errorCorrectionLevel: 'H', // High error correction
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#ffffff'
      },
      width: 300
    };

    const mergedOptions = { ...defaultOptions, ...options };
    return await QRCode.toDataURL(data, mergedOptions);
  } catch (err) {
    console.error('[QR Generation Error]', err);
    throw err;
  }
}

/**
 * Generate QR Code as Buffer (for file download)
 */
async function generateQRCodeBuffer(data, options = {}) {
  try {
    const defaultOptions = {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 300
    };
    const mergedOptions = { ...defaultOptions, ...options };
    return await QRCode.toBuffer(data, mergedOptions);
  } catch (err) {
    console.error('[QR Buffer Generation Error]', err);
    throw err;
  }
}

/**
 * Generate QR Code as SVG String
 */
async function generateQRCodeSVG(data, options = {}) {
  try {
    const defaultOptions = {
      errorCorrectionLevel: 'H',
      margin: 1,
      width: 300
    };
    const mergedOptions = { ...defaultOptions, ...options };
    return await QRCode.toString(data, { type: 'svg', ...mergedOptions });
  } catch (err) {
    console.error('[QR SVG Generation Error]', err);
    throw err;
  }
}

/**
 * Generate QR Code for AeroSync connection
 * Includes server URL, OTP, and device info
 */
async function generateConnectionQR(port = 5000, otp = null) {
  try {
    const hostname = os.hostname();
    const localIps = getLocalIpAddresses();
    
    // Get primary IP (usually the first non-loopback address returned)
    const primaryIP = localIps[0]?.address || 'localhost';

    // Build connection data
    const connectionData = {
      version: '1.0',
      type: 'aeroconnect',
      server: {
        host: primaryIP,
        port: port,
        url: `http://${primaryIP}:${port}`
      },
      ws: {
        url: `ws://${primaryIP}:${port}/ws`
      },
      otp: otp || '000000',
      device: {
        name: hostname,
        timestamp: Date.now()
      }
    };

    // Generate QR with connection URL
    const connectionURL = `aerosync://connect?host=${primaryIP}&port=${port}&otp=${otp || '000000'}`;
    
    const qrData = {
      url: connectionURL,
      data: connectionData,
      json: JSON.stringify(connectionData)
    };

    // Generate QR code with JSON data
    const qrCode = await generateQRCode(JSON.stringify(connectionData));
    
    return {
      qrCode,
      connectionData,
      connectionURL,
      qrData
    };
  } catch (err) {
    console.error('[Connection QR Generation Error]', err);
    throw err;
  }
}

module.exports = {
  generateQRCode,
  generateQRCodeBuffer,
  generateQRCodeSVG,
  generateConnectionQR
};
