const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');

const { initDb, db, saveDb } = require('../src/db');
const { router: authRouter } = require('../src/auth');
const transferRouter = require('../src/transfer');
const { router: billingRouter } = require('../src/billing');

const { router: mockCloudRouter } = require('../src/mockCloud');

const PORT = 5097;
let serverInstance;

function startTestServer() {
  const app = express();
  app.use(express.json());

  // Clear lists for pristine test run
  db.users = [];
  db.files = [];
  db.file_access = [];
  db.share_tokens = [];
  db.download_logs = [];
  db.subscriptions = [];
  db.payment_events = [];
  db.plans = [];
  saveDb();
  initDb();

  app.use('/api/auth', authRouter);
  app.use('/api/billing', billingRouter);
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

async function runBillingQuotaTests() {
  console.log('🛡️ Starting AeroSync Quota & Billing Integration Tests...');
  await startTestServer();
  console.log(`✅ Test server running on http://127.0.0.1:${PORT}`);

  try {
    // ----------------------------------------------------
    // Test 1: User Signup & Initial Plan Verification
    // ----------------------------------------------------
    console.log('\n👤 Test 1: Registering Charlie and verifying Free plan...');
    
    const registerRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'charlie@aerosync.com',
        username: 'charlie',
        password: 'charliepassword123'
      })
    });
    assert.strictEqual(registerRes.status, 201);
    const registerData = await registerRes.json();
    const token = registerData.sessionToken;
    const userId = registerData.user.id;
    assert.ok(token);

    const planRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/plan`, {
      headers: { 'X-Session-Token': token }
    });
    assert.strictEqual(planRes.status, 200);
    const planData = await planRes.json();
    assert.strictEqual(planData.planId, 'free', 'New users must start on Free plan');
    assert.strictEqual(planData.maxFileSizeBytes, 104857600, 'Free plan max size limit is 100MB');
    console.log('👉 Initial plan is successfully verified: Free.');

    // Configure Free plan limits using the admin config route (no token header to fallback to localhost host auto-login)
    const adminConfigRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/admin/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        planId: 'free',
        storageLimitBytes: 15000, // 15KB
        maxFileSizeBytes: 10000 // 10KB
      })
    });
    assert.strictEqual(adminConfigRes.status, 200);
    console.log('👉 Configured Free plan limits: 15KB storage limit, 10KB max file size limit.');

    // ----------------------------------------------------
    // Test 2: Upload Max File Size Rule Enforcement
    // ----------------------------------------------------
    console.log('\n📁 Test 2: Checking max file size limit check rule...');
    
    // Attempt uploading a 12KB file exceeding 10KB limit
    const overlimitInitRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/init-cloud`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({
        uploadId: 'test-limit-exceeded-' + crypto.randomUUID(),
        name: 'overlimit.iso',
        size: 12000,
        totalChunks: 1
      })
    });
    
    assert.strictEqual(overlimitInitRes.status, 400);
    const overlimitInitData = await overlimitInitRes.json();
    assert.strictEqual(overlimitInitData.code, 'LIMIT_EXCEEDED');
    assert.ok(overlimitInitData.error.includes('exceeds the limit'));
    console.log('👉 Correctly blocked file size over limit (12KB file on 10KB limit).');

    // ----------------------------------------------------
    // Test 3: Total Storage Limit Rule Enforcement
    // ----------------------------------------------------
    console.log('\n📁 Test 3: Checking used storage quota checks...');
    
    // Charlie has 15KB total limit. Let's upload a 9KB file, which should succeed.
    const file1Id = 'up-' + crypto.randomUUID();
    const init1Res = await fetch(`http://127.0.0.1:${PORT}/api/upload/init-cloud`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({
        uploadId: file1Id,
        name: 'movie.mkv',
        size: 9000,
        totalChunks: 1
      })
    });
    assert.strictEqual(init1Res.status, 200, '9KB file fits inside 15KB limit');
    const init1Data = await init1Res.json();

    // Upload the chunk of size 9000 bytes directly to simulated cloud presigned URL
    const chunk1Res = await fetch(`http://127.0.0.1:${PORT}${init1Data.uploadUrls[0]}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream'
      },
      body: Buffer.alloc(9000)
    });
    assert.strictEqual(chunk1Res.status, 200);

    // Complete the first file upload
    const complete1Res = await fetch(`http://127.0.0.1:${PORT}/api/upload/complete-cloud`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({ fileId: init1Data.fileId, uploadId: file1Id })
    });
    if (complete1Res.status !== 200) {
      console.error('Complete 1 upload failed:', await complete1Res.text());
    }
    assert.strictEqual(complete1Res.status, 200);
    console.log('👉 Completed 9KB upload session.');

    // Now try uploading another 7KB file. 9KB + 7KB = 16KB (exceeds 15KB storage limit)
    const overquotaInitRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/init-cloud`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({
        uploadId: 'test-quota-exceeded-' + crypto.randomUUID(),
        name: 'document.pdf',
        size: 7000,
        totalChunks: 1
      })
    });
    assert.strictEqual(overquotaInitRes.status, 400);
    const overquotaInitData = await overquotaInitRes.json();
    assert.strictEqual(overquotaInitData.code, 'QUOTA_EXCEEDED');
    assert.strictEqual(overquotaInitData.error, 'Your storage limit is reached. Upgrade your plan to continue.');
    console.log('👉 Correctly blocked upload when total used storage capacity is exceeded.');

    // ----------------------------------------------------
    // Test 4: Razorpay Webhook Billing Upgrades
    // ----------------------------------------------------
    console.log('\n💳 Test 4: Processing Razorpay subscriptions upgrade flow...');
    
    // Create subscription checkout
    const subCheckoutRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/create-subscription`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({ planId: 'pro' })
    });
    assert.strictEqual(subCheckoutRes.status, 200);
    const subCheckoutData = await subCheckoutRes.json();
    const rzpSubId = subCheckoutData.id;
    assert.ok(rzpSubId.startsWith('sub_mock_'));

    // Plan must still be free (not upgraded immediately!)
    const planCheckBeforeRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/plan`, {
      headers: { 'X-Session-Token': token }
    });
    const planCheckBeforeData = await planCheckBeforeRes.json();
    assert.strictEqual(planCheckBeforeData.planId, 'free', 'Must not upgrade plan on checkout click before payment');
    console.log('👉 Verified plan quota is NOT changed immediately.');

    // Trigger mock Razorpay Webhook payment activated success event
    const webhookRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'subscription.activated',
        isMockTest: true,
        userId: userId,
        planId: 'pro',
        subscriptionId: rzpSubId
      })
    });
    assert.strictEqual(webhookRes.status, 200);
    console.log('👉 Sent simulation Razorpay webhook activation payload.');

    // Plan must be upgraded to Pro now!
    const planCheckAfterRes = await fetch(`http://127.0.0.1:${PORT}/api/billing/plan`, {
      headers: { 'X-Session-Token': token }
    });
    const planCheckAfterData = await planCheckAfterRes.json();
    assert.strictEqual(planCheckAfterData.planId, 'pro', 'Plan must upgrade to Pro after payment success');
    assert.strictEqual(planCheckAfterData.storageLimitBytes, 53687091200, 'Pro storage limit is 50GB');
    console.log('👉 Plan successfully upgraded to Pro after webhook validation.');

    // ----------------------------------------------------
    // Test 5: Verify Upgraded limits
    // ----------------------------------------------------
    console.log('\n📁 Test 5: Testing limits checks under the Pro plan...');
    
    // Charlie can now initialize that same 7KB file (no longer quota exceeded since limit is 50GB!)
    const upgradedInitRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/init-cloud`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': token
      },
      body: JSON.stringify({
        uploadId: 'up-under-pro-' + crypto.randomUUID(),
        name: 'document.pdf',
        size: 7000,
        totalChunks: 1
      })
    });
    assert.strictEqual(upgradedInitRes.status, 200, '7KB file fits cleanly inside Pro plan capacity');
    console.log('👉 Pro plan upload size limits verified successfully.');

    // ----------------------------------------------------
    // Test 6: Free Plan Expiration (7 Days)
    // ----------------------------------------------------
    console.log('\n🕒 Test 6: Checking Free plan auto-expiration...');
    
    // Register another user on free plan
    const regFreeRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'freeman@aerosync.com',
        username: 'freeman',
        password: 'freemanpassword123'
      })
    });
    assert.strictEqual(regFreeRes.status, 201);
    const regFreeData = await regFreeRes.json();
    const freeToken = regFreeData.sessionToken;
    const freeUserId = regFreeData.user.id;

    // Simulate an uploaded file
    const fileId = 'fil_exp_' + crypto.randomUUID();
    db.files.push({
      id: fileId,
      name: 'stale_7_days.txt',
      size: 500,
      mimeType: 'text/plain',
      hash: '',
      owner_user_id: freeUserId,
      storage_type: 'local',
      created_at: Date.now() - 8 * 24 * 60 * 60 * 1000 // 8 days ago (expired!)
    });
    
    // Active file (not expired)
    const activeFileId = 'fil_act_' + crypto.randomUUID();
    db.files.push({
      id: activeFileId,
      name: 'fresh_file.txt',
      size: 300,
      mimeType: 'text/plain',
      hash: '',
      owner_user_id: freeUserId,
      storage_type: 'local',
      created_at: Date.now() - 2 * 24 * 60 * 60 * 1000 // 2 days ago (not expired)
    });
    saveDb();

    // Query file explorer list, which automatically triggers expireFreePlanFiles() background cleanup
    const filesListRes = await fetch(`http://127.0.0.1:${PORT}/api/files`, {
      headers: { 'X-Session-Token': freeToken }
    });
    assert.strictEqual(filesListRes.status, 200);
    const filesList = await filesListRes.json();
    
    // Stale file should be removed, fresh file must remain!
    const staleInResult = filesList.myFiles.find(f => f.id === fileId);
    const freshInResult = filesList.myFiles.find(f => f.id === activeFileId);

    assert.strictEqual(staleInResult, undefined, 'File older than 7 days must expire and be deleted');
    assert.ok(freshInResult, 'Fresh file must remain active');
    console.log('👉 Free plan auto-expiration validated successfully.');

    // ----------------------------------------------------
    // Test 7: Fast LAN / P2P ignores cloud quota
    // ----------------------------------------------------
    console.log('\n📁 Test 7: Checking that Fast LAN / P2P Mode ignores cloud quota...');
    
    // Set plan limits back to very low
    const adminConfigRes2 = await fetch(`http://127.0.0.1:${PORT}/api/billing/admin/plans`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        planId: 'free',
        storageLimitBytes: 1000, // 1KB
        maxFileSizeBytes: 1000 // 1KB
      })
    });
    assert.strictEqual(adminConfigRes2.status, 200);

    // Register a new user
    const regP2PRes = await fetch(`http://127.0.0.1:${PORT}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'p2puser@aerosync.com',
        username: 'p2puser',
        password: 'p2puserpassword123'
      })
    });
    assert.strictEqual(regP2PRes.status, 201);
    const p2pData = await regP2PRes.json();
    const p2pToken = p2pData.sessionToken;

    // Attempt initializing a 12KB file (exceeds 1KB limit) in LAN Mode (should succeed!)
    const lanInitRes = await fetch(`http://127.0.0.1:${PORT}/api/upload/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': p2pToken
      },
      body: JSON.stringify({
        uploadId: 'test-lan-bypass-' + crypto.randomUUID(),
        name: 'lanfile.bin',
        size: 12000,
        totalChunks: 1
      })
    });
    
    assert.strictEqual(lanInitRes.status, 200, 'LAN mode upload must succeed regardless of cloud storage limit');
    console.log('👉 Verified that LAN mode ignores cloud quota successfully.');

  } catch (err) {
    console.error('\n❌ Quota & Billing Test Suite Failed! Assertion failure:', err.message);
    if (err.stack) console.error(err.stack);
    await stopTestServer();
    process.exit(1);
  }

  await stopTestServer();
  console.log('\n🎉 AeroSync Quota & Billing Integration tests passed successfully!');
}

runBillingQuotaTests();
