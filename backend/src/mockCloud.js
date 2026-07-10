const express = require('express');
const router = express.Router();
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { CLOUD_SECRET } = require('./db');

const CLOUD_DIR = path.join(process.cwd(), 'cloud_storage');

// Middleware to verify URL signatures
function verifySignature(req, res, next) {
  const { expires, signature } = req.query;
  if (!expires || !signature) {
    return res.status(403).json({ error: 'Forbidden: Missing URL signature or expiry' });
  }

  const expiryTime = parseInt(expires, 10);
  if (isNaN(expiryTime) || Date.now() > expiryTime) {
    return res.status(403).json({ error: 'Forbidden: Signed URL has expired' });
  }

  // Signature calculation matches req path and query params (excluding signature itself)
  const pathPart = req.originalUrl.split('?')[0];
  const stringToSign = `${pathPart}?expires=${expires}`;
  const expectedSignature = crypto
    .createHmac('sha256', CLOUD_SECRET)
    .update(stringToSign)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(403).json({ error: 'Forbidden: Invalid signature' });
  }

  next();
}

// Generate S3-like presigned upload URL for a specific multipart block
function getSignedUploadUrl(sessionId, partIndex, expiresMs = 3600000) {
  const expires = Date.now() + expiresMs;
  const urlPath = `/api/mock-cloud/upload-part/${sessionId}/${partIndex}`;
  const stringToSign = `${urlPath}?expires=${expires}`;
  const signature = crypto
    .createHmac('sha256', CLOUD_SECRET)
    .update(stringToSign)
    .digest('hex');

  return `${urlPath}?expires=${expires}&signature=${signature}`;
}

// Generate S3-like presigned download URL for a file
function getSignedDownloadUrl(fileId, expiresMs = 3600000) {
  const expires = Date.now() + expiresMs;
  const urlPath = `/api/mock-cloud/download/${fileId}`;
  const stringToSign = `${urlPath}?expires=${expires}`;
  const signature = crypto
    .createHmac('sha256', CLOUD_SECRET)
    .update(stringToSign)
    .digest('hex');

  return `${urlPath}?expires=${expires}&signature=${signature}`;
}

// Endpoint: PUT upload part chunk (simulates uploading directly to cloud)
router.put('/upload-part/:sessionId/:partIndex', verifySignature, express.raw({ type: '*/*', limit: '150mb' }), async (req, res) => {
  const { sessionId, partIndex } = req.params;
  const buffer = req.body;

  if (!Buffer.isBuffer(buffer)) {
    return res.status(400).json({ error: 'Upload payload must be binary buffer' });
  }

  try {
    const tempDir = path.join(CLOUD_DIR, '.tmp', sessionId);
    await fsPromises.mkdir(tempDir, { recursive: true });
    
    const partPath = path.join(tempDir, `part_${partIndex}`);
    await fsPromises.writeFile(partPath, buffer);

    res.json({ success: true, message: `Part ${partIndex} uploaded to cloud storage successfully` });
  } catch (err) {
    console.error('[Cloud Mock Upload Error]', err);
    res.status(500).json({ error: 'Failed to write cloud part block' });
  }
});

// Endpoint: Complete multipart upload assembly
async function completeCloudMultipart(sessionId, fileId, totalChunks) {
  const tempDir = path.join(CLOUD_DIR, '.tmp', sessionId);
  const destPath = path.join(CLOUD_DIR, fileId);

  if (!fs.existsSync(tempDir)) {
    throw new Error('Upload session temporary directory not found on cloud storage');
  }

  const writeStream = fs.createWriteStream(destPath, { flags: 'w' });

  for (let i = 0; i < totalChunks; i++) {
    const partPath = path.join(tempDir, `part_${i}`);
    if (!fs.existsSync(partPath)) {
      writeStream.destroy();
      throw new Error(`Cloud upload part ${i} is missing`);
    }

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(partPath);
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

  // Cleanup temp files
  await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  return destPath;
}

// Endpoint: GET signed download file (simulates reading directly from S3/CDN)
router.get('/download/:fileId', verifySignature, async (req, res) => {
  const { fileId } = req.params;
  const filePath = path.join(CLOUD_DIR, fileId);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Cloud file target not found' });
  }

  res.sendFile(filePath);
});

module.exports = {
  router,
  getSignedUploadUrl,
  getSignedDownloadUrl,
  completeCloudMultipart
};
