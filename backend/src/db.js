const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSettings } = require('./settings');

const USERS_PATH = path.join(process.cwd(), 'users.json');
const FILES_META_PATH = path.join(process.cwd(), 'files_meta.json');
const SHARES_PATH = path.join(process.cwd(), 'shares.json');

// Memory cache
let users = [];
let filesMeta = [];
let shares = [];

// Helper to secure write JSON
function writeJson(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Failed to write database file ${filePath}:`, err);
    return false;
  }
}

// Initialize database
function initDb() {
  const settings = loadSettings();
  const baseDir = settings.sharedDirectory || path.join(process.cwd(), 'shared_files');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  // Ensure user folders exist
  const hostDir = path.join(baseDir, 'user_host');
  if (!fs.existsSync(hostDir)) {
    fs.mkdirSync(hostDir, { recursive: true });
  }

  // Load Users
  if (fs.existsSync(USERS_PATH)) {
    try {
      users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    } catch (e) {
      console.error('Error loading users, resetting:', e);
      users = [];
    }
  }

  // Ensure default host user exists
  if (!users.some(u => u.id === 'host')) {
    users.push({
      id: 'host',
      username: 'Host System',
      passwordHash: '' // Local machine auto-logs in without password check
    });
    writeJson(USERS_PATH, users);
  }

  // Load Files Metadata
  if (fs.existsSync(FILES_META_PATH)) {
    try {
      filesMeta = JSON.parse(fs.readFileSync(FILES_META_PATH, 'utf8'));
    } catch (e) {
      console.error('Error loading files_meta, resetting:', e);
      filesMeta = [];
    }
  }

  // Load Shares
  if (fs.existsSync(SHARES_PATH)) {
    try {
      shares = JSON.parse(fs.readFileSync(SHARES_PATH, 'utf8'));
    } catch (e) {
      console.error('Error loading shares, resetting:', e);
      shares = [];
    }
  }

  // Run legacy files migration to host user folder
  try {
    const items = fs.readdirSync(baseDir);
    let migratedCount = 0;
    for (const item of items) {
      if (item.startsWith('.') || item.startsWith('user_') || item === 'shared_files') continue;

      const itemPath = path.join(baseDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile()) {
        const fileId = crypto.createHash('md5').update(item + stat.size).digest('hex');
        const destPath = path.join(hostDir, fileId);

        // Move to destination
        fs.renameSync(itemPath, destPath);

        // Insert metadata
        filesMeta.push({
          fileId,
          name: item,
          size: stat.size,
          mimeType: 'application/octet-stream',
          uploadedAt: stat.mtimeMs,
          owner_user_id: 'host',
          receiver_user_id: null,
          path: destPath
        });
        migratedCount++;
      }
    }
    if (migratedCount > 0) {
      console.log(`[DB] Migrated ${migratedCount} legacy files to Host System directory.`);
      writeJson(FILES_META_PATH, filesMeta);
    }
  } catch (err) {
    console.error('[DB] Legacy migration error:', err);
  }

  console.log(`[DB] Database initialized successfully. Users: ${users.length}, Files: ${filesMeta.length}, Shares: ${shares.length}`);
}

// User methods
function getUsers() {
  return users;
}

function getUserById(id) {
  return users.find(u => u.id === id);
}

function getUserByUsername(username) {
  return users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

function registerUser(username, password) {
  if (getUserByUsername(username)) {
    throw new Error('Username already exists');
  }

  const id = 'usr_' + crypto.randomBytes(8).toString('hex');
  const passwordHash = hashPassword(password);
  const newUser = { id, username, passwordHash };

  users.push(newUser);
  writeJson(USERS_PATH, users);

  // Initialize their directory
  const settings = loadSettings();
  const userDir = path.join(settings.sharedDirectory, `user_${id}`);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  return newUser;
}

function verifyUserPassword(user, password) {
  if (!user.passwordHash) return false; // Host user has empty hash, must login via host check
  return verifyPassword(password, user.passwordHash);
}

// Password helpers
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  const parts = storedPassword.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === checkHash;
}

// File Metadata methods
function getFiles() {
  return filesMeta;
}

function getFileById(fileId) {
  return filesMeta.find(f => f.fileId === fileId);
}

function addFile(fileId, name, size, mimeType, ownerUserId, receiverUserId, physicalPath) {
  const newFile = {
    fileId,
    name,
    size,
    mimeType,
    uploadedAt: Date.now(),
    owner_user_id: ownerUserId,
    receiver_user_id: receiverUserId || null,
    path: physicalPath
  };

  // Remove existing metadata with same fileId if any
  filesMeta = filesMeta.filter(f => f.fileId !== fileId);
  filesMeta.push(newFile);
  writeJson(FILES_META_PATH, filesMeta);
  return newFile;
}

function removeFile(fileId) {
  const file = getFileById(fileId);
  if (!file) return false;

  filesMeta = filesMeta.filter(f => f.fileId !== fileId);
  writeJson(FILES_META_PATH, filesMeta);

  // Delete physical file
  if (fs.existsSync(file.path)) {
    try {
      fs.unlinkSync(file.path);
    } catch (e) {
      console.warn(`[DB] Failed to delete physical file at ${file.path}:`, e.message);
    }
  }

  // Also clean up any associated share tokens
  shares = shares.filter(s => s.fileId !== fileId);
  writeJson(SHARES_PATH, shares);

  return true;
}

// Public Share methods
function getShares() {
  return shares;
}

function getShareByToken(token) {
  const share = shares.find(s => s.token === token);
  if (!share) return null;
  if (Date.now() > share.expiresAt) {
    // Clean up expired share
    shares = shares.filter(s => s.token !== token);
    writeJson(SHARES_PATH, shares);
    return null;
  }
  return share;
}

function createShare(fileId, ownerUserId, expiresInHours = 24) {
  const token = 'sh_' + crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + (expiresInHours * 60 * 60 * 1000);

  const newShare = {
    token,
    fileId,
    expiresAt,
    owner_user_id: ownerUserId
  };

  shares.push(newShare);
  writeJson(SHARES_PATH, shares);
  return newShare;
}

function revokeShare(token) {
  shares = shares.filter(s => s.token !== token);
  writeJson(SHARES_PATH, shares);
}

module.exports = {
  initDb,
  getUsers,
  getUserById,
  getUserByUsername,
  registerUser,
  verifyUserPassword,
  getFiles,
  getFileById,
  addFile,
  removeFile,
  getShares,
  getShareByToken,
  createShare,
  revokeShare
};
