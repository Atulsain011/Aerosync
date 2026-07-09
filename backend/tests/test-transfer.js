const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const express = require('express');
const cors = require('cors');

const { loadSettings, SETTINGS_PATH } = require('../src/settings');
const { initSignaling } = require('../src/signaling');
const transferRouter = require('../src/transfer');
const { router: settingsRouter } = require('../src/settings');

const PORT = 5099;
let serverInstance;
const originalSettings = fs.existsSync(SETTINGS_PATH) ? fs.readFileSync(SETTINGS_PATH, 'utf8') : null;

// Helper to start test server
function startTestServer() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use('/api/settings', settingsRouter);
  app.use('/api/transfer', transferRouter);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    initSignaling(server);
    server.listen(PORT, '127.0.0.1', () => {
      serverInstance = server;
      resolve();
    });
  });
}

// Helper to shut down test server
function stopTestServer() {
  return new Promise((resolve) => {
    if (serverInstance) {
      serverInstance.close(() => {
        resolve();
      });
    } else {
      resolve();
    }
  });
}

async function runTests() {
  console.log('🤖 Starting Backend Integration Tests...');
  await startTestServer();
  console.log(`✅ Test server listening on http://127.0.0.1:${PORT}`);

  try {
    // ----------------------------------------------------
    // Test 1: GET Settings API
    // ----------------------------------------------------
    console.log('\n📝 Test 1: Fetching current settings...');
    const settingsRes = await fetch(`http://127.0.0.1:${PORT}/api/settings`);
    assert.strictEqual(settingsRes.status, 200, 'Settings endpoint should return 200');
    const settings = await settingsRes.json();
    assert.ok(settings.deviceName, 'Settings should contain deviceName');
    assert.ok(settings.sharedDirectory, 'Settings should contain sharedDirectory');
    assert.ok(settings.networkAddresses, 'Settings should include network interfaces');
    console.log('👉 Current device name:', settings.deviceName);
    console.log('👉 Shared directory:', settings.sharedDirectory);

    // ----------------------------------------------------
    // Test 2: POST Update Settings
    // ----------------------------------------------------
    console.log('\n📝 Test 2: Updating settings...');
    const updatedUser = 'Test Runner Client';
    const updateRes = await fetch(`http://127.0.0.1:${PORT}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: updatedUser, theme: 'cyberpunk' })
    });
    assert.strictEqual(updateRes.status, 200, 'Updating settings should return 200');
    const updateData = await updateRes.json();
    assert.strictEqual(updateData.settings.username, updatedUser, 'Username should be updated');
    assert.strictEqual(updateData.settings.theme, 'cyberpunk', 'Theme should be updated');
    console.log('👉 Settings updated and saved successfully.');

    // ----------------------------------------------------
    // Test 3: Resumable Chunked Upload
    // ----------------------------------------------------
    console.log('\n📝 Test 3: Performing resumable chunked upload...');
    const uploadId = 'test-upload-' + crypto.randomUUID();
    const fileName = 'integration-test-file.bin';
    
    // Generate a 1.5MB file in memory (three 512KB chunks)
    const chunkSize = 512 * 1024;
    const chunk0 = crypto.randomBytes(chunkSize);
    const chunk1 = crypto.randomBytes(chunkSize);
    const chunk2 = crypto.randomBytes(chunkSize);
    const totalSize = chunk0.length + chunk1.length + chunk2.length;
    const originalFileBuffer = Buffer.concat([chunk0, chunk1, chunk2]);
    const expectedHash = crypto.createHash('sha256').update(originalFileBuffer).digest('hex');

    // 3a-0. Batch init metadata support
    console.log('👉 Initializing batch upload metadata...');
    const batchId = 'test-batch-' + crypto.randomUUID();
    const batchRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/batch-init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId: batchId,
        files: [{
          name: 'batch-file.bin',
          size: totalSize,
          totalChunks: 3,
          mimeType: 'application/octet-stream',
          expectedHash
        }]
      })
    });
    assert.strictEqual(batchRes.status, 200, 'Batch init should return 200');
    const batchData = await batchRes.json();
    assert.strictEqual(batchData.batchId, batchId);
    assert.strictEqual(batchData.files.length, 1);
    await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/${batchId}`, { method: 'DELETE' });
    await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/${batchId}_0`, { method: 'DELETE' });

    // 3a. Init upload
    console.log('👉 Initializing upload session...');
    const initRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uploadId,
        name: fileName,
        size: totalSize,
        totalChunks: 3,
        mimeType: 'application/octet-stream',
        expectedHash
      })
    });
    assert.strictEqual(initRes.status, 200, 'Init should return 200');
    const initData = await initRes.json();
    assert.strictEqual(initData.uploadId, uploadId);
    assert.deepStrictEqual(initData.completedChunks, [], 'No chunks should be completed initially');

    // Helper to upload a chunk using the fast raw binary endpoint
    async function uploadChunkHelper(index, buffer, options = {}) {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/chunk/raw`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Upload-Id': uploadId,
          'X-Chunk-Index': String(index),
          ...(options.gzip ? { 'Content-Encoding': 'gzip' } : {}),
          ...(options.contentRange ? { 'Content-Range': options.contentRange } : {})
        },
        body: buffer
      });
      assert.strictEqual(res.status, 200, `Uploading chunk ${index} should return 200`);
      const body = await res.json();
      assert.strictEqual(body.chunkIndex, index);
    }

    // 3b. Upload chunk 0
    console.log('👉 Uploading chunk 0...');
    await uploadChunkHelper(0, chunk0);

    // 3c. Simulate connection drop and check status
    console.log('👉 Querying status to test resumability...');
    const statusRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/status/${uploadId}`);
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.deepStrictEqual(statusData.completedChunks, [0], 'Only chunk 0 should be completed');
    console.log('👉 Resumability check passed. Chunk 0 resides on disk. Resuming from chunk 1...');

    // 3d. Upload remaining chunks (1 and 2)
    console.log('👉 Uploading chunk 1...');
    await uploadChunkHelper(1, zlib.gzipSync(chunk1), { gzip: true });
    console.log('👉 Uploading chunk 2 in partial byte ranges...');
    const chunk2Split = Math.floor(chunk2.length / 2);
    await uploadChunkHelper(2, chunk2.subarray(0, chunk2Split), {
      contentRange: `bytes 0-${chunk2Split - 1}/${chunk2.length}`
    });
    await uploadChunkHelper(2, chunk2.subarray(chunk2Split), {
      contentRange: `bytes ${chunk2Split}-${chunk2.length - 1}/${chunk2.length}`
    });

    // 3e. Complete the upload
    console.log('👉 Completing and assembling chunks...');
    const completeRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/upload/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId, expectedHash })
    });
    assert.strictEqual(completeRes.status, 200, 'Complete should return 200');
    const completeData = await completeRes.json();
    assert.strictEqual(completeData.name, fileName);
    assert.strictEqual(completeData.sha256, expectedHash);
    console.log('👉 File merged and verified on server.');

    // ----------------------------------------------------
    // Test 4: Retrieve file list
    // ----------------------------------------------------
    console.log('\n📝 Test 4: Verifying file is listed...');
    const listRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/files`);
    assert.strictEqual(listRes.status, 200);
    const filesList = await listRes.json();
    const uploadedFile = filesList.find(f => f.name === fileName);
    assert.ok(uploadedFile, 'Uploaded file should appear in files list');
    assert.strictEqual(uploadedFile.size, totalSize, 'File size matches');
    const fileId = uploadedFile.fileId;
    console.log('👉 File ID generated:', fileId);

    // ----------------------------------------------------
    // Test 5: Range Request and Standard Download
    // ----------------------------------------------------
    console.log('\n📝 Test 5: Downloading file with HTTP Range headers...');
    
    // 5a. Partial request: middle 100 bytes (from byte 1000 to 1099)
    const rangeHeader = 'bytes=1000-1099';
    const rangeRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/download/${fileId}`, {
      headers: { 'Range': rangeHeader }
    });
    assert.strictEqual(rangeRes.status, 206, 'Should return 206 Partial Content');
    assert.strictEqual(rangeRes.headers.get('Content-Range'), `bytes 1000-1099/${totalSize}`);
    
    const rangeArrayBuffer = await rangeRes.arrayBuffer();
    const rangeBuffer = Buffer.from(rangeArrayBuffer);
    assert.strictEqual(rangeBuffer.length, 100, 'Buffer should return exactly 100 bytes');
    
    const expectedSlice = originalFileBuffer.subarray(1000, 1100);
    assert.deepStrictEqual(rangeBuffer, expectedSlice, 'Downloaded chunk bytes must match original slice');
    console.log(`👉 Range request verified successfully for: ${rangeHeader}`);

    // 5b. Full request: standard download
    console.log('👉 Downloading full file...');
    const fullRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/download/${fileId}`);
    assert.strictEqual(fullRes.status, 200);
    const fullArrayBuffer = await fullRes.arrayBuffer();
    const fullBuffer = Buffer.from(fullArrayBuffer);
    assert.deepStrictEqual(fullBuffer, originalFileBuffer, 'Full download matches uploaded file bytes');
    console.log('👉 Full download verified successfully.');

    // ----------------------------------------------------
    // Test 6: Delete File API
    // ----------------------------------------------------
    console.log('\n📝 Test 6: Deleting shared file...');
    const deleteRes = await fetch(`http://127.0.0.1:${PORT}/api/transfer/files/${fileId}`, {
      method: 'DELETE'
    });
    assert.strictEqual(deleteRes.status, 200, 'Delete should return 200');
    
    const listResAfter = await fetch(`http://127.0.0.1:${PORT}/api/transfer/files`);
    const filesListAfter = await listResAfter.json();
    const deletedFile = filesListAfter.find(f => f.name === fileName);
    assert.ok(!deletedFile, 'File should no longer exist in the directory list');
    console.log('👉 File deletion verified successfully.');

  } catch (testError) {
    console.error('\n❌ Test Suite Failed! Assertion failure:', testError.message);
    if (testError.stack) console.error(testError.stack);
    await cleanupConfig();
    await stopTestServer();
    process.exit(1);
  }

  // Cleanup configurations and temp folders
  await cleanupConfig();
  await stopTestServer();
  console.log('\n🎉 All backend tests passed successfully!');
  process.exit(0);
}

async function cleanupConfig() {
  try {
    if (originalSettings !== null) {
      fs.writeFileSync(SETTINGS_PATH, originalSettings, 'utf8');
    } else if (fs.existsSync(SETTINGS_PATH)) {
      fs.unlinkSync(SETTINGS_PATH);
    }
  } catch (e) {
    console.error('Config file cleanup failed:', e.message);
  }
}

runTests();
