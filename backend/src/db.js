const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadSettings } = require('./settings');

const DB_PATH = path.join(process.cwd(), 'database.json');

// Memory representation of the database tables
const db = {
  cancelledSessions: new Set(),
  users: [],
  files: [],
  file_access: [],
  share_tokens: [],
  upload_sessions: [],
  download_logs: [],
  plans: [
    {
      id: 'free',
      name: 'Free Plan',
      storage_limit_bytes: 1073741824, // 1GB
      max_file_size_bytes: 104857600, // 100MB
      retention_days: 7,
      sharing_limit: 2
    },
    {
      id: 'pro',
      name: 'Pro Plan',
      storage_limit_bytes: 53687091200, // 50GB
      max_file_size_bytes: 5368709120, // 5GB
      retention_days: 0,
      sharing_limit: 0
    },
    {
      id: 'business',
      name: 'Business Plan',
      storage_limit_bytes: 536870912000, // 500GB
      max_file_size_bytes: 53687091200, // 50GB
      retention_days: 0,
      sharing_limit: 0
    }
  ],
  subscriptions: [],
  payment_events: [],
  user_storage_usage: []
};

// Cryptographic signature keys
const CLOUD_SECRET = process.env.CLOUD_SECRET || crypto.randomBytes(32).toString('hex');

if (process.env.NODE_ENV === 'production' && !process.env.CLOUD_SECRET) {
  throw new Error('CLOUD_SECRET is required in production');
}

function loadDb() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      // Merge to protect schema integrity
      db.users = parsed.users || [];
      db.files = parsed.files || [];
      db.file_access = parsed.file_access || [];
      db.share_tokens = parsed.share_tokens || [];
      db.upload_sessions = parsed.upload_sessions || [];
      db.download_logs = parsed.download_logs || [];
      db.plans = parsed.plans || [];
      db.subscriptions = parsed.subscriptions || [];
      db.payment_events = parsed.payment_events || [];
      db.user_storage_usage = parsed.user_storage_usage || [];
    } else {
      saveDb();
    }
  } catch (err) {
    console.error('[DB] Failed to load database file, using empty memory model:', err);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('[DB] Failed to write database to disk:', err);
    return false;
  }
}

// Password cryptography
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword) return false;
  const parts = storedPassword.split(':');
  if (parts.length !== 2) return false;
  const [salt, hash] = parts;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === checkHash;
}

// Database initialization
function initDb() {
  loadDb();

  const settings = loadSettings();
  const baseDir = settings.sharedDirectory || path.join(process.cwd(), 'shared_files');
  const cloudDir = path.join(process.cwd(), 'cloud_storage');

  // Ensure directories exist
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }
  if (!fs.existsSync(cloudDir)) {
    fs.mkdirSync(cloudDir, { recursive: true });
  }

  // Ensure default host directories
  const hostDir = path.join(baseDir, 'user_host');
  if (!fs.existsSync(hostDir)) {
    fs.mkdirSync(hostDir, { recursive: true });
  }

  // Ensure default host user
  let hostUser = db.users.find(u => u.id === 'host');
  if (!hostUser) {
    hostUser = {
      id: 'host',
      email: 'host@aerosync.local',
      username: 'Host System',
      passwordHash: '' // localhost auto-login bypasses password check
    };
    db.users.push(hostUser);
    saveDb();
  }

  // Populate pricing plans if not present
  if (!db.plans || db.plans.length === 0) {
    db.plans = [
      {
        id: 'free',
        name: 'Free Plan',
        storage_limit_bytes: 1073741824, // 1GB
        max_file_size_bytes: 104857600, // 100MB
        retention_days: 7,
        sharing_limit: 2
      },
      {
        id: 'pro',
        name: 'Pro Plan',
        storage_limit_bytes: 53687091200, // 50GB
        max_file_size_bytes: 5368709120, // 5GB
        retention_days: 0,
        sharing_limit: 0
      },
      {
        id: 'business',
        name: 'Business Plan',
        storage_limit_bytes: 536870912000, // 500GB
        max_file_size_bytes: 53687091200, // 50GB
        retention_days: 0,
        sharing_limit: 0
      }
    ];
    saveDb();
  }

  // Legacy files migration to files table & host folder
  try {
    const items = fs.readdirSync(baseDir);
    let migrated = 0;
    for (const item of items) {
      // Ignore internal directories
      if (item.startsWith('.') || item.startsWith('user_') || item === 'shared_files') continue;

      const itemPath = path.join(baseDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isFile()) {
        const fileId = 'fil_' + crypto.createHash('md5').update(item + stat.size).digest('hex');
        const destPath = path.join(hostDir, fileId);

        // Move item
        fs.renameSync(itemPath, destPath);

        // Add metadata record
        db.files.push({
          id: fileId,
          name: item,
          size: stat.size,
          mimeType: 'application/octet-stream',
          hash: '',
          owner_user_id: 'host',
          storage_type: 'local',
          cloud_key: null,
          created_at: stat.mtimeMs
        });

        // Add upload audit log
        db.download_logs.push({
          id: 'log_' + crypto.randomBytes(8).toString('hex'),
          file_id: fileId,
          user_id: 'host',
          action: 'upload',
          details: 'Migrated legacy file to user isolation space',
          timestamp: Date.now()
        });

        migrated++;
      }
    }
    if (migrated > 0) {
      console.log(`[DB] Migrated ${migrated} legacy files to user_host/ space.`);
      saveDb();
    }
  } catch (err) {
    console.error('[DB] Legacy files migration warning:', err.message);
  }

  console.log(`[DB] AeroSync DB initialized. Users: ${db.users.length}, Files: ${db.files.length}, Logs: ${db.download_logs.length}`);
}

// Audit logger helper
function addAuditLog(fileId, userId, action, details) {
  const log = {
    id: 'log_' + crypto.randomBytes(8).toString('hex'),
    file_id: fileId,
    user_id: userId || 'anonymous',
    action,
    details: details || '',
    timestamp: Date.now()
  };
  db.download_logs.push(log);
  saveDb();
  return log;
}

// User CRUD operations
function registerUser(email, username, password) {
  if (!email || !username || !password) {
    throw new Error('All fields are required');
  }
  const cleanEmail = email.trim().toLowerCase();
  if (db.users.some(u => u.email.toLowerCase() === cleanEmail)) {
    throw new Error('Email is already registered');
  }
  if (db.users.some(u => u.username.toLowerCase() === username.trim().toLowerCase())) {
    throw new Error('Username is already registered');
  }

  const id = 'usr_' + crypto.randomBytes(8).toString('hex');
  const passwordHash = hashPassword(password);
  const user = {
    id,
    email: cleanEmail,
    username: username.trim(),
    passwordHash
  };

  db.users.push(user);
  saveDb();

  // Create isolated storage directory
  const settings = loadSettings();
  const userDir = path.join(settings.sharedDirectory, `user_${id}`);
  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  return user;
}

function authenticateUser(loginInput, password) {
  const cleanInput = loginInput.trim().toLowerCase();
  const user = db.users.find(u => u.email.toLowerCase() === cleanInput || u.username.toLowerCase() === cleanInput);
  if (!user) return null;
  if (user.id === 'host' && !user.passwordHash) return user; // Host account is local only
  if (verifyPassword(password, user.passwordHash)) {
    return user;
  }
  return null;
}

// Quota & Billing Subscription Helpers
function getUserPlan(userId) {
  // Check active subscription
  const sub = db.subscriptions.find(s => s.user_id === userId && s.status === 'active');
  const planId = sub ? sub.plan_id : 'free';
  return db.plans.find(p => p.id === planId) || db.plans.find(p => p.id === 'free');
}

function checkUploadQuota(userId, fileSize) {
  const plan = getUserPlan(userId);
  
  // Rule 1: Max file size limit check
  if (fileSize > plan.max_file_size_bytes) {
    return {
      allowed: false,
      reason: `File size exceeds the limit of ${plan.name} (${formatBytes(plan.max_file_size_bytes)})`,
      code: 'LIMIT_EXCEEDED'
    };
  }

  // Rule 2: Used storage limit check
  const usedStorage = db.files
    .filter(f => f.owner_user_id === userId && f.status !== 'pending')
    .reduce((sum, f) => sum + (f.size || 0), 0);

  if (usedStorage + fileSize > plan.storage_limit_bytes) {
    return {
      allowed: false,
      reason: `Your storage limit is reached. Upgrade your plan to continue.`,
      code: 'QUOTA_EXCEEDED'
    };
  }

  return { allowed: true, plan, usedStorage };
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Expire Free Plan files after 7 days
function expireFreePlanFiles() {
  const settings = loadSettings();
  const now = Date.now();
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000; // 7 days
  let expiredCount = 0;

  db.files.forEach(file => {
    const plan = getUserPlan(file.owner_user_id);
    if (plan.id === 'free' && (now - file.created_at) > maxAgeMs) {
      if (file.storage_type === 'local') {
        const filePath = path.join(settings.sharedDirectory, `user_${file.owner_user_id}`, file.id);
        if (fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (e) {
            console.warn('[Cleanup] Failed to unlink expired file:', filePath, e.message);
          }
        }
      }
      
      db.file_access = db.file_access.filter(a => a.file_id !== file.id);
      db.share_tokens = db.share_tokens.filter(s => s.file_id !== file.id);
      addAuditLog(file.id, file.owner_user_id, 'delete', `Auto-expired Free plan file '${file.name}' after 7 days.`);
      expiredCount++;
    }
  });

  if (expiredCount > 0) {
    db.files = db.files.filter(file => {
      const plan = getUserPlan(file.owner_user_id);
      return !(plan.id === 'free' && (now - file.created_at) > maxAgeMs);
    });
    saveDb();
    console.log(`[Cleanup] Auto-expired and removed ${expiredCount} Free plan files.`);
  }
}

// Supabase Client Initialization
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
  try {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
    console.log('[Supabase] Client initialized successfully.');
  } catch (err) {
    console.warn('[Supabase] Failed to load supabase package:', err.message);
  }
}

// Cloudflare R2/S3 compatible Client Initialization
let s3Client = null;
let s3Presigner = null;
if (process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  try {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Presigner = require('@aws-sdk/s3-request-presigner');
    s3Client = new S3Client({
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
      },
      region: 'auto'
    });
    console.log('[Cloudflare R2] S3-compatible client initialized successfully.');
  } catch (err) {
    console.warn('[Cloudflare R2] Failed to load S3 client package:', err.message);
  }
}

module.exports = {
  db,
  CLOUD_SECRET,
  initDb,
  loadDb,
  saveDb,
  addAuditLog,
  registerUser,
  authenticateUser,
  hashPassword,
  getUserPlan,
  checkUploadQuota,
  expireFreePlanFiles,
  supabase,
  s3Client,
  s3Presigner
};
