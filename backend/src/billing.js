const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db, saveDb, getUserPlan } = require('./db');
const { activeSessions } = require('./auth');
const { isLocalAddress } = require('./utils/network');

// Secure billing session check middleware
function checkSession(req, res, next) {
  const token = req.headers['x-session-token'] || req.query.sessionToken || req.body.sessionToken;
  if (token && activeSessions.has(token)) {
    const s = activeSessions.get(token);
    req.user = { id: s.userId, email: s.email, username: s.username };
    return next();
  }
  if (isLocalAddress(req.socket.remoteAddress)) {
    req.user = { id: 'host', email: 'host@aerosync.local', username: 'Host System' };
    return next();
  }
  return res.status(401).json({ error: 'Session required for billing features' });
}

// GET /api/billing/plan - Fetch logged in user plan quota metrics
router.get('/plan', checkSession, (req, res) => {
  const userId = req.user.id;
  const plan = getUserPlan(userId);
  
  // Calculate consumed space
  const usedStorage = db.files
    .filter(f => f.owner_user_id === userId && f.status !== 'pending')
    .reduce((sum, f) => sum + (f.size || 0), 0);

  res.json({
    planId: plan.id,
    planName: plan.name,
    storageLimitBytes: plan.storage_limit_bytes,
    maxFileSizeBytes: plan.max_file_size_bytes,
    usedStorageBytes: usedStorage,
    retentionDays: plan.retention_days
  });
});

// POST /api/billing/create-subscription - Generate subscription checkout ID
router.post('/create-subscription', checkSession, async (req, res) => {
  const { planId } = req.body;
  if (!['pro', 'business'].includes(planId)) {
    return res.status(400).json({ error: 'Invalid subscription plan level' });
  }

  const userId = req.user.id;
  const plan = db.plans.find(p => p.id === planId);

  // If Razorpay keys exist, interact with actual Razorpay Subscriptions client
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
      const Razorpay = require('razorpay');
      const rzp = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });

      // Map our planId to Razorpay plan ID stored in configs
      const rzpPlanKey = `RAZORPAY_PLAN_${planId.toUpperCase()}`;
      const rzpPlanId = process.env[rzpPlanKey] || 'plan_default_pro_1337';

      const subscription = await rzp.subscriptions.create({
        plan_id: rzpPlanId,
        customer_notify: 1,
        total_count: 12, // 1 year billing cycles
        notes: {
          userId,
          planId
        }
      });

      // Save draft subscription details
      db.subscriptions = db.subscriptions.filter(s => s.user_id !== userId);
      db.subscriptions.push({
        id: 'sub_' + crypto.randomBytes(8).toString('hex'),
        user_id: userId,
        plan_id: planId,
        status: 'pending',
        razorpay_subscription_id: subscription.id,
        current_period_end: Date.now() + 2 * 24 * 60 * 60 * 1000 // 48h setup grace
      });
      saveDb();

      return res.json({
        id: subscription.id,
        plan_id: planId,
        status: 'created',
        short_url: subscription.short_url
      });
    } catch (err) {
      console.error('[Razorpay Create Subscription Err]', err);
      return res.status(500).json({ error: 'Razorpay API subscription setup failed: ' + err.message });
    }
  }

  // Mock checkout session for offline testing / sandbox simulation
  const subId = 'sub_mock_' + crypto.randomBytes(8).toString('hex');
  db.subscriptions = db.subscriptions.filter(s => s.user_id !== userId);
  db.subscriptions.push({
    id: 'sub_rec_' + crypto.randomBytes(8).toString('hex'),
    user_id: userId,
    plan_id: planId,
    status: 'pending',
    razorpay_subscription_id: subId,
    current_period_end: Date.now() + 2 * 24 * 60 * 60 * 1000
  });
  saveDb();

  res.json({
    id: subId,
    plan_id: planId,
    status: 'created',
    short_url: `https://checkout.razorpay.com/mock_${subId}`
  });
});

// POST /api/billing/webhook - Listen for payment confirmations to execute upgrades
router.post('/webhook', (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  // Webhook validation (if secret is active)
  if (secret && signature) {
    try {
      const shasum = crypto.createHmac('sha256', secret);
      shasum.update(JSON.stringify(req.body));
      const digest = shasum.digest('hex');
      if (digest !== signature) {
        return res.status(403).json({ error: 'Invalid webhook signature' });
      }
    } catch (err) {
      return res.status(400).json({ error: 'Signature verification exception' });
    }
  }

  const eventName = req.body.event;
  const payload = req.body.payload || {};

  // Log transaction event
  db.payment_events.push({
    id: 'evt_' + crypto.randomBytes(8).toString('hex'),
    event_type: eventName,
    payload: req.body,
    processed_at: Date.now()
  });
  saveDb();

  console.log(`[Billing Webhook] Received event: ${eventName}`);

  if (['subscription.activated', 'subscription.charged', 'subscription.completed', 'order.paid', 'payment.captured'].includes(eventName)) {
    // Resolve user details and plan tier from entity payload notes
    const subEntity = payload.subscription ? payload.subscription.entity : null;
    const paymentEntity = payload.payment ? payload.payment.entity : null;

    let userId = null;
    let planId = null;
    let rzpSubId = null;

    if (subEntity) {
      userId = subEntity.notes?.userId;
      planId = subEntity.notes?.planId || 'pro';
      rzpSubId = subEntity.id;
    } else if (paymentEntity) {
      userId = paymentEntity.notes?.userId;
      planId = paymentEntity.notes?.planId || 'pro';
      rzpSubId = paymentEntity.notes?.subscriptionId || 'mock_direct';
    }

    // Mock testing payloads support directly
    if (req.body.isMockTest) {
      userId = req.body.userId;
      planId = req.body.planId;
      rzpSubId = req.body.subscriptionId;
    }

    if (userId && planId) {
      let subRecord = db.subscriptions.find(s => s.user_id === userId);
      if (!subRecord) {
        subRecord = {
          id: 'sub_rec_' + crypto.randomBytes(8).toString('hex'),
          user_id: userId
        };
        db.subscriptions.push(subRecord);
      }

      subRecord.plan_id = planId;
      subRecord.status = 'active';
      subRecord.razorpay_subscription_id = rzpSubId;
      subRecord.current_period_end = Date.now() + 30 * 24 * 60 * 60 * 1000; // Extend by 30 days
      saveDb();

      console.log(`[Billing Webhook] Successfully upgraded user ${userId} to ${planId} plan.`);
    }
  } else if (['subscription.halted', 'subscription.cancelled', 'subscription.pending'].includes(eventName)) {
    // Demote subscription statuses upon non-payment or cancellations
    const subEntity = payload.subscription ? payload.subscription.entity : null;
    let rzpSubId = subEntity ? subEntity.id : null;

    if (req.body.isMockTest) {
      rzpSubId = req.body.subscriptionId;
    }

    if (rzpSubId) {
      const subRecord = db.subscriptions.find(s => s.razorpay_subscription_id === rzpSubId);
      if (subRecord) {
        subRecord.status = 'cancelled';
        saveDb();
        console.log(`[Billing Webhook] Subscription ${rzpSubId} downgraded/cancelled.`);
      }
    }
  }

  res.json({ status: 'ok', event: eventName });
});

// POST /api/billing/admin/plans - Configure pricing details & capacities
router.post('/admin/plans', checkSession, (req, res) => {
  if (req.user.id !== 'host') {
    return res.status(403).json({ error: 'Access denied: Admin credentials required' });
  }

  const { planId, storageLimitBytes, maxFileSizeBytes } = req.body;
  const plan = db.plans.find(p => p.id === planId);
  if (!plan) {
    return res.status(404).json({ error: 'Target plan level not found' });
  }

  if (storageLimitBytes !== undefined) {
    plan.storage_limit_bytes = parseInt(storageLimitBytes, 10);
  }
  if (maxFileSizeBytes !== undefined) {
    plan.max_file_size_bytes = parseInt(maxFileSizeBytes, 10);
  }

  saveDb();
  res.json({ success: true, plan });
});

module.exports = {
  router,
  checkSession
};
