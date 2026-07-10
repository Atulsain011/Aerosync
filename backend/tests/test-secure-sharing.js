const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { initDb, db, saveDb } = require('../src/db');
const { router: authRouter } = require('../src/auth');
const transferRouter = require('../src/transfer');
const { router: mockCloudRouter } = require('../src/mockCloud');

const PORT = 5098;
let serverInstance;

function startTestServer() {
  const app = express();
  app.use(express.json());

  // Init DB cleanly
  initDb();
  // Flush DB lists for clean state
  db.users = [];
  db.files = [];
  db.file_access = [];
  db.share_tokens = [];
  db.download_logs = [];
  saveDb();

  app.use('/api/auth', authRouter);
  app.use('/api/mock-cloud', mockCloudRouter);
  app.use('/api', transferRouter);

  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(PORT, '127.0.0.1', () => {
      serverInstance = server;
      resolve();
    });
  });
}

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

async function runSecureSharingTests() {
  console.log('🛡️ Starting AeroSync Secure Sharing Integration Tests...');
  await startTestServer();
  console.log(`✅ Test server running on http://127.0.0.1:${PORT}`);

  try {
    // ----------------------------------------------------
    // Test 1: User Signup and Login
    // ----------------------------------------------------
    console.log('\n👤 Test 1: Creating sender and receiver accounts...');
    
    // 1a. Signup Alice (Sender)
    const signupAliceRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alice@aerosync.com',
        username: 'alice',
        password: 'alicepassword123'
      })
    });
    if (signupAliceRes.status !== 201) {
      console.error('Alice registration failed:', await signupAliceRes.text());
    }
    assert.strictEqual(signupAliceRes.status, 201);
    const aliceData = await signupAliceRes.json();
    const aliceToken = aliceData.sessionToken;
    assert.ok(aliceToken, 'Alice token must exist');
    console.log('👉 Registered Alice successfully.');

    // 1b. Signup Bob (Receiver)
    const signupBobRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'bob@aerosync.com',
        username: 'bob',
        password: 'bobpassword123'
      })
    });
    assert.strictEqual(signupBobRes.status, 201);
    const bobData = await signupBobRes.json();
    const bobToken = bobData.sessionToken;
    assert.ok(bobToken, 'Bob token must exist');
    console.log('👉 Registered Bob successfully.');

    // 1c. Login Alice to verify password auth
    const loginAliceRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        loginInput: 'alice@aerosync.com',
        password: 'alicepassword123'
      })
    });
    assert.strictEqual(loginAliceRes.status, 200);
    const loginAliceData = await loginAliceRes.json();
    assert.strictEqual(loginAliceData.user.username, 'alice');
    console.log('👉 Logged in Alice successfully.');

    // ----------------------------------------------------
    // Test 2: Upload File and Verify Owner Isolation
    // ----------------------------------------------------
    console.log('\n📁 Test 2: Uploading file as Alice & checking isolation...');
    
    // Init upload
    const uploadId = 'test-alice-upload-' + crypto.randomUUID();
    const fileName = 'alice_private_doc.txt';
    const initRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': aliceToken
      },
      body: JSON.stringify({
        uploadId,
        name: fileName,
        size: 24,
        totalChunks: 1
      })
    });
    assert.strictEqual(initRes.status, 200);

    // Upload single chunk
    const chunkRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/chunk/raw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Upload-Id': uploadId,
        'X-Chunk-Index': '0',
        'X-Session-Token': aliceToken
      },
      body: Buffer.from('Alice private document content')
    });
    assert.strictEqual(chunkRes.status, 200);

    // Complete upload
    const completeRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': aliceToken
      },
      body: JSON.stringify({ uploadId })
    });
    assert.strictEqual(completeRes.status, 200);
    const completeData = await completeRes.json();
    const fileId = completeData.fileId;
    assert.ok(fileId);
    console.log('👉 Alice file uploaded and registered. ID:', fileId);

    // 2b. Verify Bob cannot see Alice\'s file in his file list
    const bobFilesRes = await fetch(`http://127.0.0.1:${PORT}/api/files`, {
      headers: { 'X-Session-Token': bobToken }
    });
    assert.strictEqual(bobFilesRes.status, 200);
    const bobFiles = await bobFilesRes.json();
    assert.strictEqual(bobFiles.myFiles.length, 0, 'Bob should have 0 owned files');
    assert.strictEqual(bobFiles.sharedWithMe.length, 0, 'Bob should have 0 shared files');
    console.log('👉 Owner isolation confirmed: Bob files list is empty.');

    // 2c. Verify Bob gets 403 Forbidden when trying to download directly
    const bobDownloadRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/download`, {
      headers: { 'X-Session-Token': bobToken }
    });
    assert.strictEqual(bobDownloadRes.status, 403, 'Bob should be forbidden from downloading Alice\'s file');
    console.log('👉 Download authorization confirmed: Bob cannot download Alice\'s private file.');

    // ----------------------------------------------------
    // Test 3: Grant and Revoke Share Permissions
    // ----------------------------------------------------
    console.log('\n🔑 Test 3: Testing access grant and permission levels...');
    
    // 3a. Grant view-only permission to Bob
    const grantViewRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': aliceToken
      },
      body: JSON.stringify({
        email: 'bob@aerosync.com',
        permission: 'view'
      })
    });
    assert.strictEqual(grantViewRes.status, 200);
    console.log('👉 Granted view-only access to Bob.');

    // 3b. Verify Bob can see the file in shared list but cannot download
    const bobFilesSharedRes = await fetch(`http://127.0.0.1:${PORT}/api/files`, {
      headers: { 'X-Session-Token': bobToken }
    });
    const bobFilesShared = await bobFilesSharedRes.json();
    assert.strictEqual(bobFilesShared.sharedWithMe.length, 1);
    assert.strictEqual(bobFilesShared.sharedWithMe[0].permission, 'view');

    const bobDownloadViewOnlyRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/download`, {
      headers: { 'X-Session-Token': bobToken }
    });
    assert.strictEqual(bobDownloadViewOnlyRes.status, 403, 'Bob should be forbidden from downloading with view-only permission');
    console.log('👉 View-only permission restriction enforced successfully.');

    // 3c. Grant download permission to Bob
    const grantDownloadRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/share`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': aliceToken
      },
      body: JSON.stringify({
        email: 'bob@aerosync.com',
        permission: 'download'
      })
    });
    assert.strictEqual(grantDownloadRes.status, 200);
    console.log('👉 Updated Bob permission to download.');

    // 3d. Verify Bob can download the file now
    const bobDownloadSuccessRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/download`, {
      headers: { 'X-Session-Token': bobToken }
    });
    assert.strictEqual(bobDownloadSuccessRes.status, 200);
    const downloadedContent = await bobDownloadSuccessRes.text();
    assert.strictEqual(downloadedContent, 'Alice private document content');
    console.log('👉 Download permission granted and verified successfully.');

    // ----------------------------------------------------
    // Test 4: Expiring Public Share Links
    // ----------------------------------------------------
    console.log('\n🔗 Test 4: Testing public expiring share links...');

    // Generate token
    const tokenRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/share-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': aliceToken
      },
      body: JSON.stringify({
        expiresInHours: '24'
      })
    });
    assert.strictEqual(tokenRes.status, 200);
    const tokenData = await tokenRes.json();
    const token = tokenData.token;
    assert.ok(token);
    console.log('👉 Public share token generated successfully.');

    // Verify token download works without session token
    const publicDownloadRes = await fetch(`http://127.0.0.1:${PORT}/api/public/download/${token}`);
    assert.strictEqual(publicDownloadRes.status, 200);
    const publicContent = await publicDownloadRes.text();
    assert.strictEqual(publicContent, 'Alice private document content');
    console.log('👉 Public token download works for anonymous users.');

    // ----------------------------------------------------
    // Test 5: Detailed Audit Log Validation
    // ----------------------------------------------------
    console.log('\n📋 Test 5: Verifying audit logs entries...');

    const logsRes = await fetch(`http://127.0.0.1:${PORT}/api/files/${fileId}/logs`, {
      headers: { 'X-Session-Token': aliceToken }
    });
    assert.strictEqual(logsRes.status, 200);
    const logs = await logsRes.json();
    
    // Check that we have upload, share, Bob\'s download and public download logs recorded
    const uploadLog = logs.find(l => l.action === 'upload');
    const shareLog = logs.find(l => l.action === 'share');
    const downloadLog = logs.find(l => l.action === 'download' && l.userEmail === 'bob@aerosync.com');
    const publicDownloadLog = logs.find(l => l.action === 'download' && l.userEmail === 'Anonymous Guest');

    assert.ok(uploadLog, 'Upload log must be registered');
    assert.ok(shareLog, 'Share log must be registered');
    assert.ok(downloadLog, 'Bob download log must be registered');
    assert.ok(publicDownloadLog, 'Anonymous public download log must be registered');
    
    console.log('👉 Upload log description:', uploadLog.details);
    console.log('👉 Bob download log description:', downloadLog.details);
    console.log('👉 Public download log description:', publicDownloadLog.details);
    console.log('👉 Audit logs verified successfully.');

  } catch (err) {
    console.error('\n❌ Secure Sharing Test Suite Failed! Assertion failure:', err.message);
    if (err.stack) console.error(err.stack);
    await stopTestServer();
    process.exit(1);
  }

  await stopTestServer();
  console.log('\n🎉 AeroSync Secure Sharing Integration tests passed successfully!');
}

runSecureSharingTests();
