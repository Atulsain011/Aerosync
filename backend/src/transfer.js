const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const multer = require('multer');
const mime = require('mime-types');
const crypto = require('crypto');

const { db, saveDb, addAuditLog, CLOUD_SECRET } = require('./db');
const { loadSettings } = require('./settings');
const { clients } = require('./signaling');
const { isLocalAddress } = require('./utils/network');
const { activeSessions } = require('./auth');
const mockCloud = require('./mockCloud');

function sendWebSocketMessageToUser(userId, messageObj) {
  try {
    clients.forEach((c) => {
      if (c.socket && c.socket.userId === userId && c.socket.readyState === 1) {
        c.socket.send(JSON.stringify(messageObj));
      }
    });
  } catch (err) {
    console.error('Failed to send WebSocket message:', err);
  }
}

function broadcastWebSocketMessage(messageObj) {
  try {
    clients.forEach((c) => {
      if (c.socket && c.socket.readyState === 1) {
        c.socket.send(JSON.stringify(messageObj));
      }
    });
  } catch (err) {
    console.error('Failed to broadcast WebSocket message:', err);
  }
}

const CONFIG = {
  MAX_CHUNK_SIZE: 150 * 1024 * 1024,
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000,
  CLEANUP_INTERVAL: 60 * 60 * 1000,
  UPLOAD_TIMEOUT: 30 * 60 * 1000
};

// ============================================================
// DYNAMIC MEMORY SESSION CACHE FOR CHUNK TRACKING
// ============================================================
class LocalUploadSession {
  constructor(uploadId, meta) {
    this.uploadId = uploadId;
    this.meta = meta;
    this.completedChunks = new Set();
    this.isMerging = false;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }
  addChunk(index) {
    this.completedChunks.add(index);
    this.lastActivity = Date.now();
  }
  isComplete() {
    return this.completedChunks.size === parseInt(this.meta.totalChunks, 10);
  }
  getProgress() {
    return Math.round((this.completedChunks.size / parseInt(this.meta.totalChunks, 10)) * 100);
  }
}
const localUploads = new Map();

// ============================================================
// SECURITY MIDDLEWARE: checkAuthorized
// ============================================================
function checkAuthorized(req, res, next) {
  // 1. Check X-Session-Token first to ensure tokened requests are isolated correctly even on localhost
  const sessionToken = req.headers['x-session-token'] || req.query.sessionToken || req.body.sessionToken;
  if (sessionToken) {
    if (activeSessions.has(sessionToken)) {
      const s = activeSessions.get(sessionToken);
      req.user = { id: s.userId, email: s.email, username: s.username };
      return next();
    }

    const { activeGuestSessions } = require('./signaling');
    if (activeGuestSessions && activeGuestSessions.has(sessionToken)) {
      const s = activeGuestSessions.get(sessionToken);
      let guestUser = db.users.find(u => u.id === s.userId);
      if (!guestUser) {
        guestUser = {
          id: s.userId,
          email: `${s.clientId}@aerosync.local`,
          username: 'Guest Peer',
          passwordHash: ''
        };
        db.users.push(guestUser);
        saveDb();
      }
      req.user = guestUser;
      return next();
    }
  }

  // 2. Check if request is from localhost (auto-login host fallback)
  if (isLocalAddress(req.socket.remoteAddress)) {
    req.user = { id: 'host', email: 'host@aerosync.local', username: 'Host System' };
    return next();
  }

  // 3. Check client ID authorized via OTP in signaling WebSocket
  const clientId = req.headers['x-client-id'] || req.query.clientId || req.body.clientId;
  if (clientId && clients.has(clientId)) {
    const client = clients.get(clientId);
    if (client.isTrusted) {
      // Find or register guest user
      let guestUser = db.users.find(u => u.id === 'guest_' + clientId);
      if (!guestUser) {
        guestUser = {
          id: 'guest_' + clientId,
          email: `${clientId}@aerosync.local`,
          username: client.username || 'Guest Peer',
          passwordHash: ''
        };
        db.users.push(guestUser);
        saveDb();
      }
      req.user = guestUser;
      return next();
    }
  }

  return res.status(401).json({
    error: 'Unauthorized: Complete login or OTP authentication first',
    code: 'UNAUTHORIZED'
  });
}

// Attach middleware
router.use(checkAuthorized);

// ============================================================
// MULTER STORAGE CONFIGURATION WITH USER ISOLATION
// ============================================================
const isolatedStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadId = req.body.uploadId || req.query.uploadId || req.headers['x-upload-id'];
      if (!uploadId) {
        return cb(new Error('Missing x-upload-id header'));
      }

      const settings = loadSettings();
      const ownerId = req.user.id;
      // Chunks are stored in user isolated directory
      const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
      await fsPromises.mkdir(tempDir, { recursive: true });
      cb(null, tempDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    const chunkIndex = req.body.chunkIndex || req.query.chunkIndex || req.headers['x-chunk-index'];
    if (chunkIndex === undefined) {
      return cb(new Error('Missing x-chunk-index header'));
    }
    cb(null, `chunk_${chunkIndex}`);
  }
});

const upload = multer({
  storage: isolatedStorage,
  limits: { fileSize: CONFIG.MAX_CHUNK_SIZE }
}).single('chunk');

// ============================================================
// UPLOAD ROUTE: LAN MODE INIT
// ============================================================
router.post('/upload/init', async (req, res) => {
  const { name, size, totalChunks, uploadId, receiverClientId, receiverUserId, clientHash } = req.body;

  if (!name || !size || !totalChunks || !uploadId) {
    return res.status(400).json({ error: 'Missing required initialization parameters' });
  }
  try {
    const { expireFreePlanFiles } = require('./db');
    expireFreePlanFiles();

    const settings = loadSettings();
    const ownerId = req.user.id;

    // Resolve receiver user
    let resolvedReceiverId = receiverUserId || null;
    if (!resolvedReceiverId && receiverClientId) {
      // Check if client corresponds to a guest user or registered user
      const client = clients.get(receiverClientId);
      if (client) {
        resolvedReceiverId = client.id; // Map to guest client ID
      }
    }

    const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
    await fsPromises.mkdir(tempDir, { recursive: true });

    const meta = {
      name,
      size: parseInt(size, 10),
      totalChunks: parseInt(totalChunks, 10),
      uploadId,
      owner_user_id: ownerId,
      receiver_user_id: resolvedReceiverId,
      clientHash,
      initializedAt: Date.now()
    };

    await fsPromises.writeFile(path.join(tempDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

    let session = localUploads.get(uploadId);
    if (!session) {
      session = new LocalUploadSession(uploadId, meta);
      localUploads.set(uploadId, session);
    }

    res.json({
      message: 'LAN Upload session initialized successfully',
      uploadId,
      completedChunks: Array.from(session.completedChunks),
      totalChunks: meta.totalChunks,
      progress: session.getProgress()
    });
  } catch (err) {
    console.error('[Upload Init Error]', err);
    res.status(500).json({ error: 'Failed to initialize local upload' });
  }
});

// ============================================================
// UPLOAD ROUTE: LAN MODE CHUNK (MULTER)
// ============================================================
router.post('/upload/chunk', (req, res) => {
  req.setTimeout(CONFIG.UPLOAD_TIMEOUT);
  res.setTimeout(CONFIG.UPLOAD_TIMEOUT);

  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No chunk block received' });
    }

    const chunkIndex = parseInt(req.body.chunkIndex || req.headers['x-chunk-index'], 10);
    const uploadId = req.body.uploadId || req.headers['x-upload-id'];

    let session = localUploads.get(uploadId);
    if (session) {
      session.addChunk(chunkIndex);
      return res.json({
        success: true,
        chunkIndex,
        progress: session.getProgress(),
        isComplete: session.isComplete()
      });
    }

    res.json({ success: true, chunkIndex });
  });
});

// ============================================================
// UPLOAD ROUTE: LAN MODE RAW CHUNK (BINARY BODY)
// ============================================================
router.post('/upload/chunk/raw', express.raw({ type: 'application/octet-stream', limit: CONFIG.MAX_CHUNK_SIZE }), async (req, res) => {
  const uploadId = req.headers['x-upload-id'];
  const chunkIndexStr = req.headers['x-chunk-index'];

  if (!uploadId || chunkIndexStr === undefined) {
    return res.status(400).json({ error: 'Missing transfer headers' });
  }

  const chunkIndex = parseInt(chunkIndexStr, 10);
  const buffer = req.body;
  const contentRange = req.headers['content-range'];

  try {
    if (db.cancelledSessions && db.cancelledSessions.has(uploadId)) {
      return res.status(400).json({ error: 'Upload session has been cancelled' });
    }
    const settings = loadSettings();
    const ownerId = req.user.id;
    const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
    await fsPromises.mkdir(tempDir, { recursive: true });

    const chunkPath = path.join(tempDir, `chunk_${chunkIndex}`);
    let chunkComplete = true;

    if (contentRange) {
      // Format: bytes START-END/TOTAL
      const match = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+)/);
      if (match) {
        const start = parseInt(match[1], 10);
        const end = parseInt(match[2], 10);
        const total = parseInt(match[3], 10);

        if (!fs.existsSync(chunkPath)) {
          await fsPromises.writeFile(chunkPath, Buffer.alloc(0));
        }

        const handle = await fsPromises.open(chunkPath, 'r+');
        await handle.write(buffer, 0, buffer.length, start);
        await handle.close();

        const stat = await fsPromises.stat(chunkPath);
        if (stat.size < total) {
          chunkComplete = false;
        }
      } else {
        return res.status(400).json({ error: 'Invalid Content-Range header format' });
      }
    } else {
      await fsPromises.writeFile(chunkPath, buffer);
    }

    let session = localUploads.get(uploadId);
    if (!session) {
      const metaPath = path.join(tempDir, 'meta.json');
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
        session = new LocalUploadSession(uploadId, meta);
        localUploads.set(uploadId, session);
      }
    }

    if (session && chunkComplete) {
      session.addChunk(chunkIndex);
    }

    if (session) {
      res.json({
        success: true,
        chunkIndex,
        progress: session.getProgress(),
        isComplete: session.isComplete()
      });
    } else {
      res.json({ success: true, chunkIndex });
    }
  } catch (err) {
    console.error('[Raw Chunk Err]', err);
    res.status(500).json({ error: 'Failed to write raw chunk block' });
  }
});

// ============================================================
// UPLOAD ROUTE: LAN MODE COMPLETE (ASSEMBLE)
// ============================================================
router.post('/upload/complete', async (req, res) => {
  const { uploadId } = req.body;
  if (!uploadId) return res.status(400).json({ error: 'Missing uploadId' });

  try {
    const settings = loadSettings();
    const ownerId = req.user.id;
    const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
    const metaPath = path.join(tempDir, 'meta.json');

    if (!fs.existsSync(metaPath)) {
      return res.status(404).json({ error: 'Upload session metadata not found' });
    }

    const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    const totalChunks = parseInt(meta.totalChunks, 10);

    const fileId = 'fil_' + crypto.randomBytes(16).toString('hex');
    const userFolder = path.join(settings.sharedDirectory, `user_${ownerId}`);
    await fsPromises.mkdir(userFolder, { recursive: true });

    const finalPath = path.join(userFolder, fileId);

    // Merge chunks
    const writeStream = fs.createWriteStream(finalPath);
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        writeStream.destroy();
        return res.status(400).json({ error: `Chunk ${i} is missing` });
      }

      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on('error', reject);
        writeStream.on('error', reject);
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', () => {
          readStream.destroy();
          resolve();
        });
      });
    }

    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.once('finish', resolve);
      writeStream.once('error', reject);
    });

    // Compute checksum (SHA-256)
    const hash = await new Promise((resolve, reject) => {
      const sha = crypto.createHash('sha256');
      const stream = fs.createReadStream(finalPath);
      stream.on('data', d => sha.update(d));
      stream.on('end', () => resolve(sha.digest('hex')));
      stream.on('error', reject);
    });

    if (meta.clientHash && hash !== meta.clientHash) {
      await fsPromises.rm(finalPath, { force: true }).catch(() => {});
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      localUploads.delete(uploadId);
      return res.status(400).json({ error: 'File corrupted. Checksum mismatch.' });
    }

    // Cleanup temp chunks
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    localUploads.delete(uploadId);

    // Register File in DB
    const fileRecord = {
      id: fileId,
      name: meta.name,
      size: meta.size,
      mimeType: mime.lookup(meta.name) || 'application/octet-stream',
      hash,
      owner_user_id: ownerId,
      storage_type: 'local',
      cloud_key: null,
      created_at: Date.now()
    };
    db.files.push(fileRecord);

    // Share access to receiver user automatically if target provided during init
    if (meta.receiver_user_id) {
      db.file_access.push({
        id: 'acc_' + crypto.randomBytes(8).toString('hex'),
        file_id: fileId,
        user_id: meta.receiver_user_id,
        permission: 'download' // Direct transfers get download access
      });
    }
    saveDb();

    // Create Audit Log
    addAuditLog(fileId, ownerId, 'upload', `Uploaded file '${meta.name}' in LAN Mode (Local storage). Size: ${meta.size} bytes.`);

    res.json({
      status: 'approved',
      fileId,
      name: meta.name,
      hash,
      sha256: hash
    });
  } catch (err) {
    console.error('[LAN Complete Error]', err);
    res.status(500).json({ error: 'Failed to merge chunks and finalize file' });
  }
});

// BATCH UPLOAD INITIALIZATION (for backwards-compatible test validation)
router.post('/upload/batch-init', async (req, res) => {
  const { uploadId, files } = req.body;
  if (!uploadId || !files || !Array.isArray(files)) {
    return res.status(400).json({ error: 'Missing required parameters: uploadId and files array' });
  }

  try {
    const settings = loadSettings();
    const ownerId = req.user.id;
    const initializedFiles = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileUploadId = `${uploadId}_${i}`;
      const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', fileUploadId);
      await fsPromises.mkdir(tempDir, { recursive: true });

      const meta = {
        name: file.name,
        size: parseInt(file.size, 10),
        totalChunks: parseInt(file.totalChunks, 10),
        uploadId: fileUploadId,
        owner_user_id: ownerId,
        initializedAt: Date.now()
      };

      await fsPromises.writeFile(
        path.join(tempDir, 'meta.json'),
        JSON.stringify(meta, null, 2),
        'utf8'
      );

      let session = localUploads.get(fileUploadId);
      if (!session) {
        session = new LocalUploadSession(fileUploadId, meta);
        localUploads.set(fileUploadId, session);
      }

      initializedFiles.push({
        uploadId: fileUploadId,
        name: meta.name,
        size: meta.size,
        totalChunks: meta.totalChunks
      });
    }

    res.json({
      batchId: uploadId,
      files: initializedFiles
    });
  } catch (err) {
    console.error('[Batch Init Error]', err);
    res.status(500).json({ error: 'Failed to initialize batch upload' });
  }
});

// CANCEL/DELETE UPLOAD SESSION (for backwards-compatible test validation)
router.delete('/upload/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  try {
    if (db.cancelledSessions) {
      db.cancelledSessions.add(uploadId);
    }
    localUploads.delete(uploadId);
    const settings = loadSettings();
    const ownerId = req.user.id;
    const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
    const cloudTempDir = path.join(process.cwd(), 'cloud_storage', '.tmp', uploadId);
    if (fs.existsSync(cloudTempDir)) {
      await fsPromises.rm(cloudTempDir, { recursive: true, force: true }).catch(() => {});
    }
    res.json({ message: 'Upload session cancelled successfully', uploadId });
  } catch (err) {
    console.error('[Cancel Error]', err);
    res.status(500).json({ error: 'Failed to cancel upload session' });
  }
});

// ============================================================
// UPLOAD ROUTE: PRIVATE CLOUD MODE INIT
// ============================================================
router.post('/upload/init-cloud', async (req, res) => {
  const { name, size, totalChunks, uploadId, clientHash } = req.body;

  if (!name || !size || !totalChunks || !uploadId) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const { expireFreePlanFiles, checkUploadQuota } = require('./db');
    expireFreePlanFiles();

    const quotaResult = checkUploadQuota(req.user.id, parseInt(size, 10));
    if (!quotaResult.allowed) {
      return res.status(400).json({ error: quotaResult.reason, code: quotaResult.code });
    }

    const ownerId = req.user.id;
    const fileId = 'fil_c_' + crypto.randomBytes(16).toString('hex');

    // Create S3-like presigned chunk upload URLs
    const uploadUrls = [];
    for (let i = 0; i < totalChunks; i++) {
      const url = mockCloud.getSignedUploadUrl(uploadId, i);
      uploadUrls.push(url);
    }

    // Save upload session
    db.upload_sessions.push({
      id: 'ses_' + crypto.randomBytes(8).toString('hex'),
      file_id: fileId,
      upload_id: uploadId,
      storage_type: 'cloud',
      status: 'uploading',
      total_chunks: parseInt(totalChunks, 10),
      completed_chunks: [],
      clientHash
    });

    // Placeholder file entry
    db.files.push({
      id: fileId,
      name,
      size: parseInt(size, 10),
      mimeType: mime.lookup(name) || 'application/octet-stream',
      hash: '',
      owner_user_id: ownerId,
      storage_type: 'cloud',
      cloud_key: uploadId, // store session identifier
      created_at: Date.now(),
      status: 'pending' // Wait for completion
    });
    saveDb();

    res.json({
      fileId,
      uploadUrls,
      uploadId
    });
  } catch (err) {
    console.error('[Cloud Init Error]', err);
    res.status(500).json({ error: 'Failed to create cloud upload session' });
  }
});

// ============================================================
// UPLOAD ROUTE: PRIVATE CLOUD MODE COMPLETE (ASSEMBLE ON CLOUD)
// ============================================================
router.post('/upload/complete-cloud', async (req, res) => {
  const { fileId, uploadId } = req.body;
  if (!fileId || !uploadId) {
    return res.status(400).json({ error: 'Missing fileId or uploadId' });
  }

  try {
    const ownerId = req.user.id;
    const fileRecord = db.files.find(f => f.id === fileId && f.owner_user_id === ownerId);
    if (!fileRecord) {
      return res.status(404).json({ error: 'File session not found' });
    }

    const session = db.upload_sessions.find(s => s.upload_id === uploadId);
    if (!session) {
      return res.status(404).json({ error: 'Upload session not found' });
    }

    // Assemble parts directly inside cloud storage simulation (bypassing backend payload routing)
    const destPath = await mockCloud.completeCloudMultipart(uploadId, fileId, session.total_chunks);

    // Compute checksum (SHA-256) of simulated cloud file
    const hash = await new Promise((resolve, reject) => {
      const sha = crypto.createHash('sha256');
      const stream = fs.createReadStream(destPath);
      stream.on('data', d => sha.update(d));
      stream.on('end', () => resolve(sha.digest('hex')));
      stream.on('error', reject);
    });

    if (session.clientHash && hash !== session.clientHash) {
      await fsPromises.rm(destPath, { force: true }).catch(() => {});
      db.files = db.files.filter(f => f.id !== fileId);
      db.upload_sessions = db.upload_sessions.filter(s => s.upload_id !== uploadId);
      saveDb();
      return res.status(400).json({ error: 'File corrupted. Checksum mismatch.' });
    }

    // Update DB file state
    fileRecord.hash = hash;
    delete fileRecord.status; // mark active
    session.status = 'completed';
    saveDb();

    // Create Audit Log
    addAuditLog(fileId, ownerId, 'upload', `Uploaded file '${fileRecord.name}' in Private Cloud Mode. Size: ${fileRecord.size} bytes.`);

    res.json({
      success: true,
      fileId,
      name: fileRecord.name,
      hash,
      sha256: hash
    });
  } catch (err) {
    console.error('[Cloud Complete Error]', err);
    res.status(500).json({ error: 'Failed to complete cloud storage merge: ' + err.message });
  }
});

// ============================================================
// LIST FILES (Isolation logic: owner OR has access permission)
// ============================================================
router.get('/files', (req, res) => {
  const { expireFreePlanFiles } = require('./db');
  expireFreePlanFiles();

  const currentUserId = req.user.id;

  // Filter owned files
  const myFiles = db.files.filter(f => f.owner_user_id === currentUserId && f.status !== 'pending');

  // Filter shared files
  const sharedWithMe = [];
  db.file_access.forEach(access => {
    if (access.user_id === currentUserId) {
      const file = db.files.find(f => f.id === access.file_id && f.status !== 'pending');
      if (file) {
        // Find owner details
        const owner = db.users.find(u => u.id === file.owner_user_id);
        sharedWithMe.push({
          id: file.id,
          name: file.name,
          size: file.size,
          mimeType: file.mimeType,
          created_at: file.created_at,
          storage_type: file.storage_type,
          ownerEmail: owner ? owner.email : 'Unknown owner',
          permission: access.permission
        });
      }
    }
  });

  if (req.baseUrl === '/api/transfer') {
    const allFiles = [...myFiles];
    sharedWithMe.forEach(sf => {
      if (!allFiles.some(f => f.id === sf.id)) {
        allFiles.push(sf);
      }
    });
    return res.json(allFiles.map(f => ({
      fileId: f.id,
      name: f.name,
      size: f.size,
      mimeType: f.mimeType,
      uploadedAt: f.created_at
    })));
  }

  res.json({
    myFiles,
    sharedWithMe
  });
});

// ============================================================
// DELETE SHARED FILE (Only owner can delete)
// ============================================================
router.delete('/files/:fileId', (req, res) => {
  const { fileId } = req.params;
  const currentUserId = req.user.id;

  const file = db.files.find(f => f.id === fileId);
  if (!file) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Only the file owner can delete it' });
  }

  // Remove metadata
  db.files = db.files.filter(f => f.id !== fileId);
  db.file_access = db.file_access.filter(a => a.file_id !== fileId);
  db.share_tokens = db.share_tokens.filter(s => s.file_id !== fileId);
  saveDb();

  // Delete physical storage
  if (file.storage_type === 'local') {
    const settings = loadSettings();
    const filePath = path.join(settings.sharedDirectory, `user_${currentUserId}`, fileId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } else {
    // Cloud storage physical delete
    const filePath = path.join(process.cwd(), 'cloud_storage', fileId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Log audit
  addAuditLog(fileId, currentUserId, 'delete', `Deleted file '${file.name}' permanently.`);

  // Broadcast deletion to update all clients
  broadcastWebSocketMessage({ type: 'file_deleted', fileId });

  res.json({ success: true, message: 'File deleted successfully' });
});

// ============================================================
// PROTECTED ROUTE: DOWNLOAD FILE
// ============================================================
const downloadFileHandler = async (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.id;

  try {
    const file = db.files.find(f => f.id === id);
    if (!file || file.status === 'pending') {
      return res.status(404).json({ error: 'File not found' });
    }

    // Access check: owner OR has download permission
    const hasOwnerAccess = file.owner_user_id === currentUserId;
    const hasShareAccess = db.file_access.some(
      a => a.file_id === id && a.user_id === currentUserId && a.permission === 'download'
    );

    if (!hasOwnerAccess && !hasShareAccess) {
      return res.status(403).json({ error: 'Access denied: Download permission is required' });
    }

    // Log action
    addAuditLog(id, currentUserId, 'download', `Downloaded file '${file.name}'.`);

    if (file.storage_type === 'local') {
      const settings = loadSettings();
      const filePath = path.join(settings.sharedDirectory, `user_${file.owner_user_id}`, file.id);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Physical local file missing on drive' });
      }
      res.sendFile(filePath, {
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
        }
      });
    } else {
      // Cloud storage: Redirect or return direct signed cloud URL to bypass Express download payload routing
      const signedUrl = mockCloud.getSignedDownloadUrl(file.id);
      if (req.headers['accept'] && req.headers['accept'].includes('application/json')) {
        return res.json({ downloadUrl: signedUrl });
      } else {
        return res.redirect(signedUrl);
      }
    }
  } catch (err) {
    console.error('[Download Err]', err);
    res.status(500).json({ error: 'Failed to process file download' });
  }
};

router.get('/files/:id/download', downloadFileHandler);
router.get('/download/:id', downloadFileHandler);

// ============================================================
// ACCESS MANAGEMENT: GET LIST OF USERS WITH FILE ACCESS
// ============================================================
router.get('/files/:id/share-info', (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.id;

  const file = db.files.find(f => f.id === id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Access details are owner private' });
  }

  // Get details
  const sharedUsers = [];
  db.file_access.forEach(a => {
    if (a.file_id === id) {
      const user = db.users.find(u => u.id === a.user_id);
      if (user) {
        sharedUsers.push({
          userId: user.id,
          email: user.email,
          username: user.username,
          permission: a.permission
        });
      }
    }
  });

  res.json({
    ownerEmail: req.user.email,
    sharedUsers
  });
});

// ============================================================
// ACCESS MANAGEMENT: GRANT SHARING PERMISSION
// ============================================================
router.post('/files/:id/share', (req, res) => {
  const { id } = req.params;
  const { email, permission } = req.body;
  const currentUserId = req.user.id;

  if (!email || !permission) {
    return res.status(400).json({ error: 'Email and permission level are required' });
  }

  const file = db.files.find(f => f.id === id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Only file owner can share it' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  const targetUser = db.users.find(u => u.email.toLowerCase() === cleanEmail);
  if (!targetUser) {
    return res.status(404).json({ error: 'No registered user found with this email.' });
  }

  if (targetUser.id === currentUserId) {
    return res.status(400).json({ error: 'Cannot share file with yourself' });
  }

  // Remove existing permission if any
  db.file_access = db.file_access.filter(a => !(a.file_id === id && a.user_id === targetUser.id));

  // Grant access
  db.file_access.push({
    id: 'acc_' + crypto.randomBytes(8).toString('hex'),
    file_id: id,
    user_id: targetUser.id,
    permission
  });
  saveDb();

  addAuditLog(id, currentUserId, 'share', `Granted access permission '${permission}' to user email '${email}'.`);

  // Broadcast WebSocket notification to target user in real-time
  sendWebSocketMessageToUser(targetUser.id, { type: 'file_shared', fileId: id });

  res.json({ success: true, message: `Access granted to user ${targetUser.username}` });
});

// ============================================================
// ACCESS MANAGEMENT: REVOKE SHARING PERMISSION
// ============================================================
router.delete('/files/:id/share/:userId', (req, res) => {
  const { id, userId } = req.params;
  const currentUserId = req.user.id;

  const file = db.files.find(f => f.id === id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Only owner can revoke access' });
  }

  db.file_access = db.file_access.filter(a => !(a.file_id === id && a.user_id === userId));
  saveDb();

  const targetUser = db.users.find(u => u.id === userId);
  const email = targetUser ? targetUser.email : 'Unknown';

  addAuditLog(id, currentUserId, 'share', `Revoked sharing access for user email '${email}'.`);

  // Broadcast WebSocket notification to target user in real-time
  sendWebSocketMessageToUser(userId, { type: 'access_removed', fileId: id });

  res.json({ success: true, message: 'Access revoked successfully' });
});

// ============================================================
// RANDOM EXPIRING PUBLIC SHARE LINKS GENERATION
// ============================================================
router.post('/files/:id/share-link', (req, res) => {
  const { id } = req.params;
  const { expiresInHours, permission } = req.body;
  const currentUserId = req.user.id;

  const file = db.files.find(f => f.id === id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Only file owner can generate public share links' });
  }

  const hours = parseInt(expiresInHours, 10) || 24;
  const token = 'tok_' + crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + (hours * 60 * 60 * 1000);

  db.share_tokens.push({
    id: 'tok_rec_' + crypto.randomBytes(8).toString('hex'),
    file_id: id,
    token,
    permission: permission || 'download',
    expires_at: expiresAt,
    created_by: currentUserId
  });
  saveDb();

  addAuditLog(id, currentUserId, 'share', `Generated public expiring share token. Expiring in ${hours} hours.`);

  res.json({
    success: true,
    token,
    expiresAt
  });
});

// ============================================================
// PUBLIC EXPIRING ACCESS DOWNLOAD ENDPOINT (BYPASS AUTH)
// ============================================================
// (We add it to the main router without checkAuthorized, but here we place it in a separate sub-router
// or handle it at the top of this file by checking if the route path is public)
// To keep things simple and secure, we'll let /download-shared/:token bypass checkAuthorized in server.js
// or we will declare it on a separate router. Let's declare it in a separate file or handle it here by
// bypass in middleware.
// Wait! Let's check checkAuthorized middleware above. It checks req.path and rejects.
// Let's modify checkAuthorized middleware (line 33) to allow `/public/download/:token` to bypass!
// Yes! Let's do that:
// In checkAuthorized:
// if (req.path.startsWith('/public/download/')) return next();
// This is perfect!
// Let's implement the public download endpoint here:
router.get('/public/download/:token', async (req, res) => {
  const { token } = req.params;

  try {
    const share = db.share_tokens.find(s => s.token === token);
    if (!share) {
      return res.status(404).send('Download link is invalid or has been revoked');
    }

    if (share.permission === 'view') {
      return res.status(403).send('Access Denied: Download not allowed for this link');
    }

    if (Date.now() > share.expires_at) {
      // Invalidate expired token
      db.share_tokens = db.share_tokens.filter(s => s.token !== token);
      saveDb();
      return res.status(403).send('Download link has expired');
    }

    const file = db.files.find(f => f.id === share.file_id);
    if (!file || file.status === 'pending') {
      return res.status(404).send('Shared file is no longer available');
    }

    // Add audit log
    addAuditLog(file.id, 'public_guest', 'download', `Downloaded file via public share token '${token}'.`);

    if (file.storage_type === 'local') {
      const settings = loadSettings();
      const filePath = path.join(settings.sharedDirectory, `user_${file.owner_user_id}`, file.id);
      if (!fs.existsSync(filePath)) {
        return res.status(404).send('Physical local file missing on drive');
      }
      res.sendFile(filePath, {
        headers: {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(file.name)}"`
        }
      });
    } else {
      // Cloud storage signed URL redirect
      const signedUrl = mockCloud.getSignedDownloadUrl(file.id);
      return res.redirect(signedUrl);
    }
  } catch (err) {
    console.error('[Public Download Err]', err);
    res.status(500).send('Server error processing public download');
  }
});

// ============================================================
// AUDIT LOGS: GET ACTION LOGS FOR FILE (Only owner can see)
// ============================================================
router.get('/files/:id/logs', (req, res) => {
  const { id } = req.params;
  const currentUserId = req.user.id;

  const file = db.files.find(f => f.id === id);
  if (!file) return res.status(404).json({ error: 'File not found' });

  if (file.owner_user_id !== currentUserId) {
    return res.status(403).json({ error: 'Forbidden: Access audit logs is file owner private' });
  }

  // Filter logs for this file
  const logs = db.download_logs
    .filter(l => l.file_id === id)
    .map(l => {
      // Resolve user detail
      const user = db.users.find(u => u.id === l.user_id);
      return {
        id: l.id,
        action: l.action,
        details: l.details,
        timestamp: l.timestamp,
        userEmail: user ? user.email : (l.user_id === 'public_guest' ? 'Anonymous Guest' : 'System')
      };
    })
    .sort((a, b) => b.timestamp - a.timestamp); // newest first

  res.json(logs);
});

// GET /upload/status/:uploadId (for testing chunked resume support)
router.get('/upload/status/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  const session = localUploads.get(uploadId);
  if (session) {
    return res.json({
      uploadId,
      completedChunks: Array.from(session.completedChunks),
      progress: session.getProgress(),
      totalChunks: parseInt(session.meta.totalChunks, 10)
    });
  }
  
  // Try check disk
  const settings = loadSettings();
  const ownerId = req.user.id;
  const tempDir = path.join(settings.sharedDirectory, `user_${ownerId}`, '.tmp', uploadId);
  const metaPath = path.join(tempDir, 'meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const files = fs.readdirSync(tempDir);
      const completedChunks = [];
      for (const file of files) {
        if (file.startsWith('chunk_')) {
          const idx = parseInt(file.split('_')[1], 10);
          if (!isNaN(idx)) completedChunks.push(idx);
        }
      }
      return res.json({
        uploadId,
        completedChunks,
        progress: Math.round((completedChunks.length / meta.totalChunks) * 100),
        totalChunks: meta.totalChunks
      });
    } catch (e) {
      // ignore
    }
  }
  res.status(404).json({ error: 'Session not found' });
});

router.post('/files/p2p-metadata', (req, res) => {
  const { fileId, name, size, mimeType, senderId, receiverId, fileHash } = req.body;
  
  if (!fileId || !name || !size) {
    return res.status(400).json({ error: 'fileId, name, and size are required' });
  }

  let fileRecord = db.files.find(f => f.id === fileId);
  if (!fileRecord) {
    fileRecord = {
      id: fileId,
      name,
      size: parseInt(size, 10),
      mimeType: mimeType || 'application/octet-stream',
      hash: fileHash || '',
      owner_user_id: senderId || 'host',
      storage_type: 'p2p',
      created_at: Date.now()
    };
    db.files.push(fileRecord);
    
    if (receiverId) {
      db.file_access.push({
        id: 'acc_' + crypto.randomBytes(8).toString('hex'),
        file_id: fileId,
        user_id: receiverId,
        permission: 'download'
      });
    }
    saveDb();
  }

  // Broadcast WebSocket notifications to room in real-time
  broadcastWebSocketMessage({ type: 'file_received', fileId, senderId, receiverId });
  broadcastWebSocketMessage({ type: 'file_uploaded', fileId, senderId });

  res.json({ success: true, file: fileRecord });
});

module.exports = router;
// Append check for bypass to checkAuthorized
const oldCheckAuthorized = checkAuthorized;
function checkAuthorizedWithBypass(req, res, next) {
  if (req.path.startsWith('/public/download/')) {
    return next();
  }
  return oldCheckAuthorized(req, res, next);
}
// Replace router middleware
const index = router.stack.findIndex(layer => layer.handle === checkAuthorized);
if (index !== -1) {
  router.stack[index].handle = checkAuthorizedWithBypass;
}