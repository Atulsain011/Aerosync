const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isLocalAddress } = require('./utils/network');

const SETTINGS_PATH = path.join(process.cwd(), 'settings.json');

/**
 * Builds the default settings structure.
 * Resolves local directories and machine hostnames dynamically.
 */
function getDefaultSettings() {
  return {
    deviceName: os.hostname() || 'AeroShare Node',
    sharedDirectory: path.join(process.cwd(), 'shared_files'),
    theme: 'modern-computer',
    port: 5000,
    downloadSpeedLimit: 0, // KB/s, 0 = unlimited
    uploadSpeedLimit: 0,   // KB/s, 0 = unlimited
    allowWebRTC: true,
    enableTunnel: false,
    cdnBaseUrl: '',
    username: 'Host System',
    avatar: 'monitor'
  };
}

/**
 * Loads configuration from settings.json or initializes with defaults.
 */
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
      const loaded = JSON.parse(raw);
      // Merge with default schema to ensure all properties exist
      return { ...getDefaultSettings(), ...loaded };
    }
  } catch (err) {
    console.error('Error loading settings, returning defaults:', err);
  }

  const defaults = getDefaultSettings();
  saveSettings(defaults);
  return defaults;
}

/**
 * Persists the configuration object to settings.json.
 */
function saveSettings(settings) {
  try {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Failed to write settings to file:', err);
    return false;
  }
}

// Initialize settings and output paths on startup
const currentSettings = loadSettings();
try {
  if (!fs.existsSync(currentSettings.sharedDirectory)) {
    fs.mkdirSync(currentSettings.sharedDirectory, { recursive: true });
  }
} catch (e) {
  console.error(`Warning: Failed to verify shared directory ${currentSettings.sharedDirectory}:`, e.message);
}

// GET /api/settings
router.get('/', (req, res) => {
  const settings = loadSettings();

  // Dynamically resolve local network interfaces
  const { getLocalIpAddresses } = require('./utils/network');
  const networkAddresses = getLocalIpAddresses();
  const { getPublicTunnelUrl } = require('./utils/tunnel');

  res.json({
    ...settings,
    networkAddresses,
    publicTunnelUrl: getPublicTunnelUrl()
  });
});

// POST /api/settings
router.post('/', (req, res) => {
  if (!isLocalAddress(req.socket.remoteAddress)) {
    return res.status(401).json({ error: 'Unauthorized: Only the host machine can edit configurations' });
  }
  const incoming = req.body;
  const current = loadSettings();

  // Validate and parse incoming configurations safely
  const updated = {
    deviceName: incoming.deviceName || current.deviceName,
    sharedDirectory: incoming.sharedDirectory || current.sharedDirectory,
    theme: incoming.theme || current.theme,
    port: parseInt(incoming.port) || current.port,
    downloadSpeedLimit: incoming.downloadSpeedLimit !== undefined ? parseInt(incoming.downloadSpeedLimit) : current.downloadSpeedLimit,
    uploadSpeedLimit: incoming.uploadSpeedLimit !== undefined ? parseInt(incoming.uploadSpeedLimit) : current.uploadSpeedLimit,
    allowWebRTC: incoming.allowWebRTC !== undefined ? !!incoming.allowWebRTC : current.allowWebRTC,
    enableTunnel: incoming.enableTunnel !== undefined ? !!incoming.enableTunnel : current.enableTunnel,
    cdnBaseUrl: incoming.cdnBaseUrl !== undefined ? String(incoming.cdnBaseUrl).trim() : current.cdnBaseUrl,
    username: incoming.username || current.username,
    avatar: incoming.avatar || current.avatar
  };

  // Handle tunnel startup/shutdown dynamically on config change
  if (updated.enableTunnel !== current.enableTunnel) {
    const { startTunnel, stopTunnel } = require('./utils/tunnel');
    if (updated.enableTunnel) {
      startTunnel(updated.port);
    } else {
      stopTunnel();
    }
  }

  // Create shared folder if path has changed
  if (updated.sharedDirectory !== current.sharedDirectory) {
    try {
      if (!fs.existsSync(updated.sharedDirectory)) {
        fs.mkdirSync(updated.sharedDirectory, { recursive: true });
      }
    } catch (e) {
      return res.status(400).json({ error: `Cannot write or create directory: ${e.message}` });
    }
  }

  const saved = saveSettings(updated);
  if (saved) {
    res.json({ message: 'Settings saved successfully', settings: updated });
  } else {
    res.status(500).json({ error: 'Failed to write settings to disk' });
  }
});

module.exports = {
  router,
  loadSettings,
  SETTINGS_PATH
};
