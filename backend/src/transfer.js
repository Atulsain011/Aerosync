const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const multer = require('multer');
const mime = require('mime-types');
const crypto = require('crypto');
const { loadSettings } = require('./settings');
const { clients } = require('./signaling');
const { isLocalAddress } = require('./utils/network');

// ============================================================
// PRODUCTION CONFIGURATION
// ============================================================
const CONFIG = {
  // Chunk size: 150MB - Optimal for most networks
  MAX_CHUNK_SIZE: 150 * 1024 * 1024,

  // Merge buffer: 16MB - Reduces I/O operations
  MERGE_BUFFER_SIZE: 16 * 1024 * 1024,

  // Session timeout: 24 hours
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000,

  // Cleanup interval: Every hour
  CLEANUP_INTERVAL: 60 * 60 * 1000,

  // Max retry attempts for failed operations
  MAX_RETRIES: 3,

  // Retry delay in milliseconds
  RETRY_DELAY: 1000,

  // Upload timeout: 30 minutes
  UPLOAD_TIMEOUT: 30 * 60 * 1000,

  // Max concurrent uploads per session
  MAX_CONCURRENT_CHUNKS: 5
};

// ============================================================
// ENHANCED SESSION MANAGEMENT
// ============================================================
class UploadSession {
  constructor(uploadId, meta) {
    this.uploadId = uploadId;
    this.meta = meta;
    this.completedChunks = new Set();
    this.isMerging = false;
    this.mergeError = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.totalChunks = parseInt(meta.totalChunks, 10);
    this.chunkTimestamps = new Map();
    this.uploadStartTime = Date.now();
    this.bytesUploaded = 0;
    this.uploadSpeed = 0;
    this.lock = false;
  }

  addChunk(index, size = 0) {
    this.completedChunks.add(index);
    this.chunkTimestamps.set(index, Date.now());
    this.bytesUploaded += size;
    this.lastActivity = Date.now();

    // Calculate upload speed (MB/s)
    const elapsed = (Date.now() - this.uploadStartTime) / 1000;
    if (elapsed > 0) {
      this.uploadSpeed = (this.bytesUploaded / 1024 / 1024) / elapsed;
    }
  }

  isComplete() {
    return this.completedChunks.size === this.totalChunks;
  }

  getMissingChunks() {
    const missing = [];
    for (let i = 0; i < this.totalChunks; i++) {
      if (!this.completedChunks.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  getProgress() {
    return Math.round((this.completedChunks.size / this.totalChunks) * 100);
  }

  getETA() {
    if (this.uploadSpeed === 0 || this.completedChunks.size === 0) return null;
    const remainingChunks = this.totalChunks - this.completedChunks.size;
    const avgChunkSize = this.bytesUploaded / this.completedChunks.size;
    const remainingBytes = remainingChunks * avgChunkSize;
    const remainingSeconds = remainingBytes / 1024 / 1024 / this.uploadSpeed;
    return Math.round(remainingSeconds);
  }

  isExpired() {
    return Date.now() - this.lastActivity > CONFIG.SESSION_TIMEOUT;
  }

  canMerge() {
    return this.isComplete() && !this.isMerging && !this.mergeError;
  }
}

const uploadSessions = new Map();

// ============================================================
// OPTIMIZED HELPERS
// ============================================================
function broadcastToHosts(data) {
  const raw = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.isHost && client.socket.readyState === 1) {
      try { client.socket.send(raw); } catch (err) { /* ignore */ }
    }
  });
}

function broadcastToAll(data) {
  const raw = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.socket.readyState === 1) {
      try { client.socket.send(raw); } catch (err) { /* ignore */ }
    }
  });
}

function isSafeUploadId(uploadId) {
  return typeof uploadId === 'string' && /^[a-zA-Z0-9_-]+$/.test(uploadId);
}

function sanitizeFilename(filename) {
  // Remove dangerous characters
  return filename.replace(/[^a-zA-Z0-9\-_. ]/g, '');
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================================
// ADVANCED AUTHORIZATION
// ============================================================
function checkAuthorized(req, res, next) {
  // Check if request is from localhost
  if (isLocalAddress(req.socket.remoteAddress)) {
    req.isTrusted = true;
    return next();
  }

  // Check client ID
  const clientId = req.headers['x-client-id'] || req.query.clientId || req.body.clientId;
  if (clientId && clients.has(clientId)) {
    const client = clients.get(clientId);
    req.isTrusted = client.isTrusted || false;
    req.clientId = clientId;
    req.clientInfo = client;
    return next();
  }

  // Check API key (for service-to-service communication)
  const apiKey = req.headers['x-api-key'];
  if (apiKey && process.env.API_KEY && apiKey === process.env.API_KEY) {
    req.isTrusted = true;
    return next();
  }

  return res.status(401).json({
    error: 'Unauthorized: Complete OTP authorization first',
    code: 'UNAUTHORIZED'
  });
}

router.use(checkAuthorized);

// ============================================================
// MULTER STORAGE WITH VALIDATION
// ============================================================
const tempStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const uploadId = req.body.uploadId || req.query.uploadId || req.headers['x-upload-id'];
      if (!uploadId) {
        return cb(new Error('Missing uploadId (required in body, query, or x-upload-id header)'));
      }
      if (!isSafeUploadId(uploadId)) {
        return cb(new Error('Invalid uploadId format'));
      }

      const settings = loadSettings();
      if (!settings || !settings.sharedDirectory) {
        return cb(new Error('Settings not properly configured'));
      }

      const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
      await fsPromises.mkdir(tempDir, { recursive: true });

      // Check disk space
      const { available } = await checkDiskSpace(tempDir);
      if (available < CONFIG.MAX_CHUNK_SIZE * 2) {
        return cb(new Error('Insufficient disk space for upload'));
      }

      cb(null, tempDir);
    } catch (err) {
      cb(new Error(`Failed to create temp directory: ${err.message}`));
    }
  },
  filename: (req, file, cb) => {
    try {
      const chunkIndex = req.body.chunkIndex || req.query.chunkIndex || req.headers['x-chunk-index'];
      if (chunkIndex === undefined) {
        return cb(new Error('Missing chunkIndex (required in body, query, or x-chunk-index header)'));
      }

      const index = parseInt(chunkIndex, 10);
      if (isNaN(index) || index < 0) {
        return cb(new Error('Invalid chunkIndex: must be a positive integer'));
      }

      cb(null, `chunk_${index}`);
    } catch (err) {
      cb(err);
    }
  }
});

// File filter for security
const fileFilter = (req, file, cb) => {
  // Allow all files but validate size
  cb(null, true);
};

const upload = multer({
  storage: tempStorage,
  fileFilter: fileFilter,
  limits: {
    fileSize: CONFIG.MAX_CHUNK_SIZE,
    files: 1,
    parts: 10,
    headerSize: 8192
  }
}).single('chunk');

// ============================================================
// DISK SPACE CHECKER
// ============================================================
async function checkDiskSpace(directory) {
  try {
    const stats = await fsPromises.statfs ?
      await fsPromises.statfs(directory) :
      { bavail: 1024 * 1024 * 1024, bsize: 4096 }; // Fallback: 4GB
    return {
      available: stats.bavail * stats.bsize,
      total: stats.blocks * stats.bsize
    };
  } catch (err) {
    // Fallback: assume 1GB available
    return { available: 1 * 1024 * 1024 * 1024, total: 10 * 1024 * 1024 * 1024 };
  }
}

// ============================================================
// UPLOAD INIT - ENHANCED
// ============================================================
router.post('/upload/init', async (req, res) => {
  const { name, size, totalChunks, mimeType, uploadId, expectedHash, metadata } = req.body;

  // Validate required parameters
  if (!name || !size || !totalChunks || !uploadId) {
    return res.status(400).json({
      error: 'Missing required parameters',
      required: ['name', 'size', 'totalChunks', 'uploadId'],
      received: Object.keys(req.body),
      code: 'MISSING_PARAMS'
    });
  }

  // Validate uploadId
  if (!isSafeUploadId(uploadId)) {
    return res.status(400).json({
      error: 'Invalid uploadId format',
      code: 'INVALID_UPLOAD_ID'
    });
  }

  // Validate size
  const parsedSize = parseInt(size, 10);
  if (isNaN(parsedSize) || parsedSize <= 0) {
    return res.status(400).json({
      error: 'Invalid file size',
      code: 'INVALID_SIZE'
    });
  }

  // Validate totalChunks
  const parsedTotalChunks = parseInt(totalChunks, 10);
  if (isNaN(parsedTotalChunks) || parsedTotalChunks <= 0) {
    return res.status(400).json({
      error: 'Invalid totalChunks',
      code: 'INVALID_TOTAL_CHUNKS'
    });
  }

  // Check if file already exists
  const settings = loadSettings();
  const finalPath = path.join(settings.sharedDirectory, name);
  if (fs.existsSync(finalPath)) {
    // Check if it's a resume or new upload
    const stats = await fsPromises.stat(finalPath);
    if (stats.size === parsedSize) {
      return res.status(409).json({
        error: 'File already exists with same size',
        code: 'FILE_EXISTS',
        fileId: Buffer.from(name).toString('hex')
      });
    }
  }

  try {
    const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
    await fsPromises.mkdir(tempDir, { recursive: true });

    // Create session metadata
    const meta = {
      name: sanitizeFilename(name),
      size: parsedSize,
      totalChunks: parsedTotalChunks,
      mimeType: mimeType || 'application/octet-stream',
      uploadId,
      expectedHash,
      metadata: metadata || {},
      initializedAt: Date.now(),
      clientId: req.clientId || 'unknown'
    };

    // Save metadata to disk
    await fsPromises.writeFile(
      path.join(tempDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8'
    );

    // Create or recover session
    let session = uploadSessions.get(uploadId);
    if (!session) {
      session = new UploadSession(uploadId, meta);

      // Check for existing chunks (resume support)
      try {
        const files = await fsPromises.readdir(tempDir);
        let totalSize = 0;
        for (const file of files) {
          if (file.startsWith('chunk_')) {
            const idx = parseInt(file.split('_')[1], 10);
            if (!isNaN(idx)) {
              const stat = await fsPromises.stat(path.join(tempDir, file));
              session.addChunk(idx, stat.size);
              totalSize += stat.size;
            }
          }
        }
        console.log(`[Upload] Recovered ${session.completedChunks.size}/${meta.totalChunks} chunks for ${uploadId}`);
      } catch (err) {
        // Ignore recovery errors
      }
      uploadSessions.set(uploadId, session);
    }

    // Calculate ETA
    const eta = session.getETA();

    res.json({
      message: 'Upload session initialized successfully',
      uploadId,
      completedChunks: Array.from(session.completedChunks),
      totalChunks: meta.totalChunks,
      progress: session.getProgress(),
      eta: eta ? `${eta}s` : null,
      uploadSpeed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      isResume: session.completedChunks.size > 0
    });

    // Broadcast initialization to hosts
    broadcastToHosts({
      type: 'upload-started',
      uploadId,
      name: meta.name,
      size: meta.size,
      clientId: req.clientId || 'unknown'
    });

  } catch (err) {
    console.error('[Upload Init Error]', err);
    res.status(500).json({
      error: 'Failed to initialize upload session',
      details: err.message,
      code: 'INIT_FAILED'
    });
  }
});

// ============================================================
// UPLOAD CHUNK - PRODUCTION READY
// ============================================================
router.post('/upload/chunk', (req, res) => {
  // Set timeout for long-running uploads
  req.setTimeout(CONFIG.UPLOAD_TIMEOUT);
  res.setTimeout(CONFIG.UPLOAD_TIMEOUT);

  upload(req, res, async (err) => {
    if (err) {
      console.error('[Chunk Upload Error]', err);
      return res.status(400).json({
        error: err.message,
        code: err.code || 'UPLOAD_ERROR'
      });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'No chunk file received',
        code: 'NO_FILE'
      });
    }

    // Extract parameters
    const chunkIndex = parseInt(
      req.body.chunkIndex || req.query.chunkIndex || req.headers['x-chunk-index'],
      10
    );
    const uploadId = req.body.uploadId || req.query.uploadId || req.headers['x-upload-id'];
    const totalChunks = parseInt(
      req.body.totalChunks || req.query.totalChunks || req.headers['x-total-chunks'] || 0,
      10
    );

    if (isNaN(chunkIndex) || chunkIndex < 0) {
      return res.status(400).json({
        error: 'Invalid chunkIndex',
        code: 'INVALID_INDEX'
      });
    }

    // Get or recover session
    let session = uploadSessions.get(uploadId);
    if (!session) {
      try {
        const settings = loadSettings();
        const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
        const metaPath = path.join(tempDir, 'meta.json');

        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
          session = new UploadSession(uploadId, meta);

          // Load existing chunks
          const files = await fsPromises.readdir(tempDir);
          for (const file of files) {
            if (file.startsWith('chunk_')) {
              const idx = parseInt(file.split('_')[1], 10);
              if (!isNaN(idx)) {
                const stat = await fsPromises.stat(path.join(tempDir, file));
                session.addChunk(idx, stat.size);
              }
            }
          }
          uploadSessions.set(uploadId, session);
          console.log(`[Upload] Recovered session ${uploadId} with ${session.completedChunks.size} chunks`);
        } else {
          return res.status(404).json({
            error: 'Upload session not found. Please call /upload/init first.',
            code: 'SESSION_NOT_FOUND'
          });
        }
      } catch (recoveryErr) {
        console.error('[Session Recovery Error]', recoveryErr);
        return res.status(500).json({
          error: 'Failed to recover upload session',
          details: recoveryErr.message,
          code: 'RECOVERY_FAILED'
        });
      }
    }

    // Validate chunk index
    if (chunkIndex >= session.totalChunks) {
      return res.status(400).json({
        error: `Chunk index ${chunkIndex} exceeds total chunks ${session.totalChunks - 1}`,
        code: 'INDEX_OUT_OF_RANGE',
        maxIndex: session.totalChunks - 1
      });
    }

    // Check if chunk already uploaded (idempotent)
    if (session.completedChunks.has(chunkIndex)) {
      // Verify chunk exists and has correct size
      const settings = loadSettings();
      const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
      const chunkPath = path.join(tempDir, `chunk_${chunkIndex}`);

      if (fs.existsSync(chunkPath)) {
        const stat = await fsPromises.stat(chunkPath);
        // If chunk exists, return success
        if (stat.size > 0) {
          return res.json({
            message: 'Chunk already uploaded',
            chunkIndex,
            duplicate: true,
            progress: session.getProgress(),
            completed: session.completedChunks.size,
            total: session.totalChunks
          });
        }
      }

      // Chunk marked as completed but file missing - remove from set
      session.completedChunks.delete(chunkIndex);
    }

    // Add chunk to session
    const fileSize = req.file.size || 0;
    session.addChunk(chunkIndex, fileSize);

    // Check if all chunks are uploaded
    const isComplete = session.isComplete();

    // Send progress update via WebSocket
    const progress = session.getProgress();
    const eta = session.getETA();

    broadcastToAll({
      type: 'upload-progress',
      uploadId,
      chunkIndex,
      progress,
      completed: session.completedChunks.size,
      total: session.totalChunks,
      speed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      eta: eta ? `${eta}s` : null,
      isComplete
    });

    res.json({
      message: 'Chunk uploaded successfully',
      chunkIndex,
      progress,
      completed: session.completedChunks.size,
      total: session.totalChunks,
      speed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      eta: eta ? `${eta}s` : null,
      isComplete
    });

    // If complete, optionally auto-merge
    if (isComplete && req.body.autoMerge === 'true') {
      // Auto-merge in background
      const isLocal = isLocalAddress(req.socket.remoteAddress) || req.isTrusted;
      setImmediate(() => {
        handleMerge(uploadId, req.body.expectedHash, isLocal).catch(err => {
          console.error('[Auto-Merge Error]', err);
        });
      });
    }
  });
});

// ============================================================
// MERGE FUNCTION - EXTRACTED FOR REUSE
// ============================================================
// ============================================================
// MERGE FUNCTION - FIXED FOR LARGE FILES
// ============================================================
async function handleMerge(uploadId, expectedHashParam, isLocalOverride = null) {
  const session = uploadSessions.get(uploadId);
  if (!session) {
    throw new Error('Session not found');
  }

  if (!session.canMerge()) {
    throw new Error('Session cannot be merged');
  }

  session.isMerging = true;

  try {
    const settings = loadSettings();
    // ✅ FIX: Use override or detect from caller
    const isLocal = isLocalOverride !== null ? isLocalOverride : false;
    const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
    const meta = session.meta;

    let finalPath;
    let fileId = null;

    // ✅ FIX: Properly handle remote vs local
    if (isLocal) {
      finalPath = path.join(settings.sharedDirectory, meta.name);
    } else {
      const pendingDir = path.join(settings.sharedDirectory, '.pending_approvals');
      await fsPromises.mkdir(pendingDir, { recursive: true });
      fileId = crypto.randomBytes(16).toString('hex');
      finalPath = path.join(pendingDir, `${fileId}_file`);
    }

    // Check if file already exists
    if (fs.existsSync(finalPath) && isLocal) {
      const ext = path.extname(meta.name);
      const base = path.basename(meta.name, ext);
      let counter = 1;
      let newPath;
      do {
        newPath = path.join(settings.sharedDirectory, `${base} (${counter})${ext}`);
        counter++;
      } while (fs.existsSync(newPath));
      finalPath = newPath;
      console.log(`[Upload] File exists, renamed to ${path.basename(finalPath)}`);
    }

    // ============================================================
    // ✅ FIXED: STREAMING MERGE - NO MEMORY OVERHEAD
    // ============================================================
    const totalChunks = session.totalChunks;
    const mergeStartTime = Date.now();

    // Use pipeline for memory-efficient streaming
    const writeStream = fs.createWriteStream(finalPath, {
      flags: 'wx',
      highWaterMark: 16 * 1024 * 1024, // 16MB buffer
      mode: 0o666
    });

    // ✅ Process chunks with streams (no loading into memory)
    for (let i = 0; i < totalChunks; i++) {
      const chunkPath = path.join(tempDir, `chunk_${i}`);

      if (!fs.existsSync(chunkPath)) {
        throw new Error(`Chunk ${i} is missing during merge`);
      }

      // ✅ Stream chunk directly to write stream
      await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath, {
          highWaterMark: 16 * 1024 * 1024
        });

        // Handle backpressure properly
        const onError = (err) => {
          readStream.destroy();
          writeStream.destroy(err);
          reject(err);
        };

        readStream.on('error', onError);
        writeStream.on('error', onError);

        // Pipe with backpressure handling
        readStream.pipe(writeStream, { end: false });

        readStream.on('end', () => {
          readStream.destroy();
          // Update progress
          const mergeProgress = Math.round(((i + 1) / totalChunks) * 100);
          broadcastToAll({
            type: 'upload-merge-progress',
            uploadId,
            progress: mergeProgress,
            chunk: i + 1,
            total: totalChunks
          });
          resolve();
        });
      });
    }

    // Finalize write stream
    await new Promise((resolve, reject) => {
      writeStream.end();
      writeStream.once('finish', resolve);
      writeStream.once('error', reject);
    });

    const mergeTime = Date.now() - mergeStartTime;

    // Verify file size
    const stats = await fsPromises.stat(finalPath);
    if (stats.size !== parseInt(meta.size, 10)) {
      throw new Error(`File size mismatch: expected ${meta.size}, got ${stats.size}`);
    }

    // Calculate file hash (streaming)
    const fileHash = await calculateFileHash(finalPath);
    const expectedHash = expectedHashParam || meta.expectedHash;
    if (expectedHash && fileHash !== expectedHash) {
      await fsPromises.unlink(finalPath).catch(() => { });
      throw new Error(`Hash mismatch: expected ${expectedHash}, got ${fileHash}`);
    }

    // Clean up temp directory
    try {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    } catch (rmErr) {
      console.warn('[Upload] Temp cleanup warning:', rmErr);
    }

    uploadSessions.delete(uploadId);

    console.log(`[Upload] File merged: ${meta.name} (${formatFileSize(meta.size)}) in ${mergeTime}ms`);

    return {
      success: true,
      finalPath,
      fileId,
      name: meta.name,
      size: meta.size,
      hash: fileHash,
      mergeTime
    };

  } catch (err) {
    console.error('[Merge Error]', err);
    session.isMerging = false;
    session.mergeError = err.message;
    throw err;
  }
}
// ============================================================
// UPLOAD COMPLETE - PRODUCTION READY
// ============================================================
router.post('/upload/complete', async (req, res) => {
  const { uploadId, expectedHash } = req.body;

  if (!uploadId || !isSafeUploadId(uploadId)) {
    return res.status(400).json({
      error: 'Invalid or missing uploadId',
      code: 'INVALID_UPLOAD_ID'
    });
  }

  const session = uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({
      error: 'Upload session not found',
      code: 'SESSION_NOT_FOUND'
    });
  }

  // Check if session can be merged
  if (!session.canMerge()) {
    if (session.isMerging) {
      return res.status(409).json({
        error: 'Upload is already being processed',
        code: 'ALREADY_MERGING'
      });
    }
    if (session.mergeError) {
      return res.status(500).json({
        error: 'Previous merge failed',
        details: session.mergeError,
        code: 'MERGE_FAILED'
      });
    }
    if (!session.isComplete()) {
      const missing = session.getMissingChunks();
      return res.status(400).json({
        error: 'Missing chunks',
        code: 'MISSING_CHUNKS',
        missingChunks: missing,
        completed: Array.from(session.completedChunks),
        total: session.totalChunks,
        progress: session.getProgress()
      });
    }
  }

  try {
    // Set uploadId for merge function
    const isLocal = isLocalAddress(req.socket.remoteAddress) || req.isTrusted;

    // Merge the file
    const result = await handleMerge(uploadId, expectedHash, isLocal);

    // If local, broadcast file update
    if (isLocal) {
      broadcastToAll({
        type: 'file-list-updated',
        file: {
          name: result.name,
          size: result.size,
          path: result.finalPath
        }
      });
    } else {
      // Save pending metadata
      const settings = loadSettings();
      const pendingDir = path.join(settings.sharedDirectory, '.pending_approvals');
      const pendingMetaPath = path.join(pendingDir, `${result.fileId}_meta.json`);
      const senderName = req.body.senderName || 'Remote Peer';

      const metaData = {
        fileId: result.fileId,
        name: result.name,
        size: result.size,
        mimeType: session.meta.mimeType || 'application/octet-stream',
        senderName,
        uploadedAt: Date.now(),
        hash: result.hash,
        clientId: req.clientId || 'unknown'
      };

      await fsPromises.writeFile(
        pendingMetaPath,
        JSON.stringify(metaData, null, 2),
        'utf8'
      );

      broadcastToHosts({
        type: 'upload-pending',
        file: metaData
      });
    }

    // Send response
    res.json({
      status: isLocal ? 'approved' : 'pending',
      message: isLocal ? 'File completed and assembled successfully' : 'Upload complete. Waiting for host approval.',
      name: result.name,
      size: result.size,
      mimeType: session.meta.mimeType || 'application/octet-stream',
      hash: result.hash,
      sha256: result.hash,
      fileId: result.fileId,
      mergeTime: `${result.mergeTime}ms`,
      uploadedAt: new Date().toISOString()
    });

  } catch (err) {
    console.error('[Complete Error]', err);

    // Clean up
    try {
      const settings = loadSettings();
      const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
      if (fs.existsSync(tempDir)) {
        await fsPromises.rm(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.warn('[Cleanup Error]', cleanupErr);
    }

    res.status(500).json({
      error: 'Failed to complete upload',
      details: err.message,
      code: 'COMPLETE_FAILED',
      uploadId
    });
  }
});

// ============================================================
// CALCULATE FILE HASH
// ============================================================
async function calculateFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, {
      highWaterMark: 1024 * 1024 // 1MB chunks for hashing
    });

    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ============================================================
// UPLOAD STATUS - ENHANCED
// ============================================================
router.get('/upload/status/:uploadId', async (req, res) => {
  const { uploadId } = req.params;

  if (!isSafeUploadId(uploadId)) {
    return res.status(400).json({
      error: 'Invalid uploadId format',
      code: 'INVALID_UPLOAD_ID'
    });
  }

  // Check memory session first
  const session = uploadSessions.get(uploadId);
  if (session) {
    const missingChunks = session.getMissingChunks();
    return res.json({
      uploadId,
      meta: session.meta,
      completedChunks: Array.from(session.completedChunks),
      progress: session.getProgress(),
      isMerging: session.isMerging,
      mergeError: session.mergeError,
      missingChunks: missingChunks,
      totalChunks: session.totalChunks,
      uploadSpeed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      eta: session.getETA() ? `${session.getETA()}s` : null,
      bytesUploaded: session.bytesUploaded,
      isComplete: session.isComplete(),
      canMerge: session.canMerge(),
      status: session.isMerging ? 'merging' :
        session.mergeError ? 'error' :
          session.isComplete() ? 'complete' : 'uploading'
    });
  }

  // Check disk
  const settings = loadSettings();
  const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);

  if (!fs.existsSync(tempDir)) {
    return res.status(404).json({
      error: 'Upload session not found',
      code: 'SESSION_NOT_FOUND'
    });
  }

  try {
    let meta = {};
    const metaPath = path.join(tempDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    }

    const files = await fsPromises.readdir(tempDir);
    const completedChunks = [];
    let bytesUploaded = 0;

    for (const file of files) {
      if (file.startsWith('chunk_')) {
        const idx = parseInt(file.split('_')[1], 10);
        if (!isNaN(idx)) {
          completedChunks.push(idx);
          const stat = await fsPromises.stat(path.join(tempDir, file));
          bytesUploaded += stat.size;
        }
      }
    }

    res.json({
      uploadId,
      meta,
      completedChunks,
      progress: Math.round((completedChunks.length / meta.totalChunks) * 100),
      totalChunks: meta.totalChunks,
      bytesUploaded,
      status: completedChunks.length === meta.totalChunks ? 'complete' : 'uploading'
    });
  } catch (err) {
    console.error('[Status Error]', err);
    res.status(500).json({
      error: 'Failed to retrieve upload status',
      details: err.message,
      code: 'STATUS_FAILED'
    });
  }
});

// ============================================================
// CANCEL UPLOAD - PRODUCTION READY
// ============================================================
router.delete('/upload/:uploadId', async (req, res) => {
  const { uploadId } = req.params;

  if (!isSafeUploadId(uploadId)) {
    return res.status(400).json({
      error: 'Invalid uploadId',
      code: 'INVALID_UPLOAD_ID'
    });
  }

  const settings = loadSettings();
  const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
  const resolvedTmpRoot = path.resolve(settings.sharedDirectory, '.tmp');
  const resolvedTempDir = path.resolve(tempDir);

  // Security: Prevent directory traversal
  if (!resolvedTempDir.startsWith(`${resolvedTmpRoot}${path.sep}`)) {
    return res.status(403).json({
      error: 'Access denied: Directory traversal blocked',
      code: 'ACCESS_DENIED'
    });
  }

  try {
    // Remove session from memory
    uploadSessions.delete(uploadId);

    // Delete temporary files
    if (fs.existsSync(tempDir)) {
      await fsPromises.rm(resolvedTempDir, { recursive: true, force: true });
      console.log(`[Upload] Cancelled session ${uploadId}`);
    }

    // Broadcast cancellation
    broadcastToAll({
      type: 'upload-cancelled',
      uploadId
    });

    res.json({
      message: 'Upload session cancelled successfully',
      uploadId,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('[Cancel Error]', err);
    res.status(500).json({
      error: 'Failed to cancel upload session',
      details: err.message,
      code: 'CANCEL_FAILED'
    });
  }
});

// ============================================================
// RETRY FAILED UPLOAD
// ============================================================
router.post('/upload/retry/:uploadId', async (req, res) => {
  const { uploadId } = req.params;

  if (!isSafeUploadId(uploadId)) {
    return res.status(400).json({
      error: 'Invalid uploadId',
      code: 'INVALID_UPLOAD_ID'
    });
  }

  const session = uploadSessions.get(uploadId);
  if (!session) {
    return res.status(404).json({
      error: 'Session not found',
      code: 'SESSION_NOT_FOUND'
    });
  }

  if (session.isMerging) {
    return res.status(409).json({
      error: 'Upload is currently processing',
      code: 'ALREADY_MERGING'
    });
  }

  // Reset merge error
  session.mergeError = null;
  session.isMerging = false;

  // Get missing chunks
  const missingChunks = session.getMissingChunks();

  res.json({
    message: 'Retry initiated successfully',
    uploadId,
    missingChunks,
    progress: session.getProgress(),
    totalChunks: session.totalChunks,
    timestamp: new Date().toISOString()
  });
});

// ============================================================
// CLEANUP STALE SESSIONS
// ============================================================
setInterval(async () => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [uploadId, session] of uploadSessions) {
    if (session.isExpired()) {
      cleanedCount++;
      console.log(`[Cleanup] Removing stale session: ${uploadId} (${session.getProgress()}%)`);

      // Remove from memory
      uploadSessions.delete(uploadId);

      // Remove files
      try {
        const settings = loadSettings();
        const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
        if (fs.existsSync(tempDir)) {
          await fsPromises.rm(tempDir, { recursive: true, force: true });
        }
      } catch (err) {
        console.warn(`[Cleanup] Failed to remove files for ${uploadId}:`, err);
      }
    }
  }

  if (cleanedCount > 0) {
    console.log(`[Cleanup] Removed ${cleanedCount} stale sessions`);
  }
}, CONFIG.CLEANUP_INTERVAL);

// ============================================================
// BATCH UPLOAD INITIALIZATION
// ============================================================
router.post('/upload/batch-init', async (req, res) => {
  const { uploadId, files } = req.body;

  if (!uploadId || !files || !Array.isArray(files)) {
    return res.status(400).json({
      error: 'Missing required parameters: uploadId and files array',
      code: 'MISSING_PARAMS'
    });
  }

  const settings = loadSettings();
  const initializedFiles = [];

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { name, size, totalChunks, mimeType, expectedHash, metadata } = file;
      const fileUploadId = `${uploadId}_${i}`;

      const parsedSize = parseInt(size, 10);
      const parsedTotalChunks = parseInt(totalChunks, 10);

      const tempDir = path.join(settings.sharedDirectory, '.tmp', fileUploadId);
      await fsPromises.mkdir(tempDir, { recursive: true });

      const meta = {
        name: sanitizeFilename(name),
        size: parsedSize,
        totalChunks: parsedTotalChunks,
        mimeType: mimeType || 'application/octet-stream',
        uploadId: fileUploadId,
        expectedHash,
        metadata: metadata || {},
        initializedAt: Date.now(),
        clientId: req.clientId || 'unknown'
      };

      await fsPromises.writeFile(
        path.join(tempDir, 'meta.json'),
        JSON.stringify(meta, null, 2),
        'utf8'
      );

      let session = uploadSessions.get(fileUploadId);
      if (!session) {
        session = new UploadSession(fileUploadId, meta);
        uploadSessions.set(fileUploadId, session);
      }

      initializedFiles.push({
        uploadId: fileUploadId,
        name: meta.name,
        size: meta.size,
        totalChunks: meta.totalChunks,
        mimeType: meta.mimeType,
        expectedHash
      });

      broadcastToHosts({
        type: 'upload-started',
        uploadId: fileUploadId,
        name: meta.name,
        size: meta.size,
        clientId: req.clientId || 'unknown'
      });
    }

    res.json({
      batchId: uploadId,
      files: initializedFiles
    });
  } catch (err) {
    console.error('[Batch Init Error]', err);
    res.status(500).json({
      error: 'Failed to initialize batch upload',
      details: err.message,
      code: 'BATCH_INIT_FAILED'
    });
  }
});

// ============================================================
// RAW CHUNK UPLOAD
// ============================================================
router.post('/upload/chunk/raw', express.raw({ type: 'application/octet-stream', limit: CONFIG.MAX_CHUNK_SIZE }), async (req, res) => {
  const uploadId = req.headers['x-upload-id'];
  const chunkIndexStr = req.headers['x-chunk-index'];
  const contentRange = req.headers['content-range'];

  if (!uploadId || chunkIndexStr === undefined) {
    return res.status(400).json({
      error: 'Missing x-upload-id or x-chunk-index header',
      code: 'MISSING_HEADERS'
    });
  }

  const chunkIndex = parseInt(chunkIndexStr, 10);
  if (isNaN(chunkIndex) || chunkIndex < 0) {
    return res.status(400).json({
      error: 'Invalid x-chunk-index header',
      code: 'INVALID_INDEX'
    });
  }

  // Get or recover session
  let session = uploadSessions.get(uploadId);
  if (!session) {
    try {
      const settings = loadSettings();
      const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
      const metaPath = path.join(tempDir, 'meta.json');

      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
        session = new UploadSession(uploadId, meta);

        // Load existing chunks
        const files = await fsPromises.readdir(tempDir);
        for (const file of files) {
          if (file.startsWith('chunk_')) {
            const idx = parseInt(file.split('_')[1], 10);
            if (!isNaN(idx)) {
              const stat = await fsPromises.stat(path.join(tempDir, file));
              session.addChunk(idx, stat.size);
            }
          }
        }
        uploadSessions.set(uploadId, session);
        console.log(`[Upload] Recovered session ${uploadId} with ${session.completedChunks.size} chunks`);
      } else {
        return res.status(404).json({
          error: 'Upload session not found. Please call /upload/init first.',
          code: 'SESSION_NOT_FOUND'
        });
      }
    } catch (recoveryErr) {
      console.error('[Session Recovery Error]', recoveryErr);
      return res.status(500).json({
        error: 'Failed to recover upload session',
        details: recoveryErr.message,
        code: 'RECOVERY_FAILED'
      });
    }
  }

  if (chunkIndex >= session.totalChunks) {
    return res.status(400).json({
      error: `Chunk index ${chunkIndex} exceeds total chunks ${session.totalChunks - 1}`,
      code: 'INDEX_OUT_OF_RANGE',
      maxIndex: session.totalChunks - 1
    });
  }

  const buffer = req.body;
  if (!Buffer.isBuffer(buffer)) {
    return res.status(400).json({
      error: 'Invalid request body, expected raw binary buffer',
      code: 'INVALID_BODY'
    });
  }

  try {
    const settings = loadSettings();
    const tempDir = path.join(settings.sharedDirectory, '.tmp', uploadId);
    const chunkPath = path.join(tempDir, `chunk_${chunkIndex}`);

    let chunkComplete = true;
    let bytesWritten = buffer.length;

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
        return res.status(400).json({
          error: 'Invalid Content-Range header format',
          code: 'INVALID_CONTENT_RANGE'
        });
      }
    } else {
      await fsPromises.writeFile(chunkPath, buffer);
    }

    if (chunkComplete) {
      session.completedChunks.add(chunkIndex);
      session.chunkTimestamps.set(chunkIndex, Date.now());
    }
    session.bytesUploaded += bytesWritten;
    session.lastActivity = Date.now();

    // Calculate upload speed
    const elapsed = (Date.now() - session.uploadStartTime) / 1000;
    if (elapsed > 0) {
      session.uploadSpeed = (session.bytesUploaded / 1024 / 1024) / elapsed;
    }

    const isComplete = session.isComplete();
    const progress = session.getProgress();
    const eta = session.getETA();

    broadcastToAll({
      type: 'upload-progress',
      uploadId,
      chunkIndex,
      progress,
      completed: session.completedChunks.size,
      total: session.totalChunks,
      speed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      eta: eta ? `${eta}s` : null,
      isComplete
    });

    res.json({
      message: chunkComplete ? 'Chunk uploaded successfully' : 'Chunk slice uploaded successfully',
      chunkIndex,
      progress,
      completed: session.completedChunks.size,
      total: session.totalChunks,
      speed: session.uploadSpeed ? `${session.uploadSpeed.toFixed(2)} MB/s` : null,
      eta: eta ? `${eta}s` : null,
      isComplete
    });

  } catch (writeErr) {
    console.error('[Raw Chunk Write Error]', writeErr);
    res.status(500).json({
      error: 'Failed to write chunk file',
      details: writeErr.message,
      code: 'WRITE_FAILED'
    });
  }
});

// ============================================================
// PENDING APPROVALS LIST
// ============================================================
router.get('/pending', async (req, res) => {
  try {
    const settings = loadSettings();
    const pendingDir = path.join(settings.sharedDirectory, '.pending_approvals');
    if (!fs.existsSync(pendingDir)) {
      return res.json([]);
    }
    const files = await fsPromises.readdir(pendingDir);
    const list = [];
    for (const file of files) {
      if (file.endsWith('_meta.json')) {
        try {
          const raw = await fsPromises.readFile(path.join(pendingDir, file), 'utf8');
          const meta = JSON.parse(raw);
          list.push(meta);
        } catch (e) {
          // Ignore parsing errors for individual corrupt files
        }
      }
    }
    res.json(list);
  } catch (err) {
    console.error('[Get Pending Error]', err);
    res.status(500).json({ error: 'Failed to retrieve pending uploads' });
  }
});

// ============================================================
// APPROVE PENDING UPLOAD
// ============================================================
router.post('/approve', async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: 'Missing fileId' });
  }

  try {
    const settings = loadSettings();
    const pendingDir = path.join(settings.sharedDirectory, '.pending_approvals');
    const metaPath = path.join(pendingDir, `${fileId}_meta.json`);
    const dataPath = path.join(pendingDir, `${fileId}_file`);

    if (!fs.existsSync(metaPath) || !fs.existsSync(dataPath)) {
      return res.status(404).json({ error: 'Pending upload not found' });
    }

    const meta = JSON.parse(await fsPromises.readFile(metaPath, 'utf8'));
    let finalPath = path.join(settings.sharedDirectory, meta.name);

    // Resolve name conflict if file exists
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(meta.name);
      const base = path.basename(meta.name, ext);
      let counter = 1;
      let newPath;
      do {
        newPath = path.join(settings.sharedDirectory, `${base} (${counter})${ext}`);
        counter++;
      } while (fs.existsSync(newPath));
      finalPath = newPath;
    }

    // Move file to final path
    await fsPromises.rename(dataPath, finalPath);

    // Remove pending meta
    await fsPromises.unlink(metaPath).catch(() => { });

    // Broadcast update
    broadcastToAll({
      type: 'file-list-updated',
      file: {
        name: path.basename(finalPath),
        size: meta.size,
        path: finalPath
      }
    });

    res.json({ message: 'File approved and moved successfully', name: path.basename(finalPath) });
  } catch (err) {
    console.error('[Approve Error]', err);
    res.status(500).json({ error: 'Failed to approve file' });
  }
});

// ============================================================
// REJECT PENDING UPLOAD
// ============================================================
router.post('/reject', async (req, res) => {
  const { fileId } = req.body;
  if (!fileId) {
    return res.status(400).json({ error: 'Missing fileId' });
  }

  try {
    const settings = loadSettings();
    const pendingDir = path.join(settings.sharedDirectory, '.pending_approvals');
    const metaPath = path.join(pendingDir, `${fileId}_meta.json`);
    const dataPath = path.join(pendingDir, `${fileId}_file`);

    if (fs.existsSync(dataPath)) {
      await fsPromises.unlink(dataPath).catch(() => { });
    }
    if (fs.existsSync(metaPath)) {
      await fsPromises.unlink(metaPath).catch(() => { });
    }

    res.json({ message: 'File upload request rejected and deleted successfully' });
  } catch (err) {
    console.error('[Reject Error]', err);
    res.status(500).json({ error: 'Failed to reject file' });
  }
});

// ============================================================
// FILE LISTING SERVICE
// ============================================================
router.get('/files', async (req, res) => {
  try {
    const settings = loadSettings();
    const dir = settings.sharedDirectory;
    if (!fs.existsSync(dir)) {
      return res.json([]);
    }
    const items = await fsPromises.readdir(dir);
    const list = [];
    for (const item of items) {
      if (item.startsWith('.')) continue;

      const filePath = path.join(dir, item);
      const stat = await fsPromises.stat(filePath);

      if (stat.isFile()) {
        const fileId = Buffer.from(item).toString('hex');
        const mimeType = mime.lookup(filePath) || 'application/octet-stream';
        list.push({
          fileId,
          name: item,
          size: stat.size,
          mimeType,
          uploadedAt: stat.mtimeMs
        });
      }
    }
    res.json(list);
  } catch (err) {
    console.error('[Get Files Error]', err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// ============================================================
// DOWNLOAD FILE (HTTP RANGE COMPATIBLE)
// ============================================================
router.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;
  try {
    const filename = Buffer.from(fileId, 'hex').toString('utf8');
    const settings = loadSettings();
    const filePath = path.join(settings.sharedDirectory, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    res.sendFile(filePath, {
      headers: {
        'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`
      }
    });
  } catch (err) {
    console.error('[Download Error]', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// ============================================================
// DELETE SHARED FILE
// ============================================================
router.delete('/files/:fileId', async (req, res) => {
  const { fileId } = req.params;
  try {
    const filename = Buffer.from(fileId, 'hex').toString('utf8');
    const settings = loadSettings();
    const filePath = path.join(settings.sharedDirectory, filename);

    // Prevent directory traversal
    const resolvedSharedDir = path.resolve(settings.sharedDirectory);
    const resolvedFilePath = path.resolve(filePath);
    if (!resolvedFilePath.startsWith(resolvedSharedDir + path.sep) && resolvedFilePath !== resolvedSharedDir) {
      return res.status(403).json({ error: 'Access denied: directory traversal blocked' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    await fsPromises.unlink(filePath);

    broadcastToAll({
      type: 'file-list-deleted',
      fileId
    });

    res.json({ message: 'File deleted successfully', fileId });
  } catch (err) {
    console.error('[Delete File Error]', err);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ============================================================
// Health Check Endpoint
// ============================================================
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    activeSessions: uploadSessions.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

module.exports = router;