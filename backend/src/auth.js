const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { registerUser, authenticateUser, db } = require('./db');

// In-memory active user sessions registry
const activeSessions = new Map();

// POST /api/auth/register
router.post('/register', (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const user = registerUser(email, username, password);
    // Auto-login upon registration
    const sessionToken = 'ses_' + crypto.randomBytes(16).toString('hex');
    activeSessions.set(sessionToken, {
      userId: user.id,
      email: user.email,
      username: user.username
    });

    res.status(201).json({
      message: 'User registered successfully',
      sessionToken,
      user: { id: user.id, email: user.email, username: user.username }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { loginInput, password } = req.body;
  if (!loginInput || !password) {
    return res.status(400).json({ error: 'Username/Email and password are required' });
  }

  const user = authenticateUser(loginInput, password);
  if (!user) {
    return res.status(401).json({ error: 'Invalid login credentials' });
  }

  const sessionToken = 'ses_' + crypto.randomBytes(16).toString('hex');
  activeSessions.set(sessionToken, {
    userId: user.id,
    email: user.email,
    username: user.username
  });

  res.json({
    message: 'Logged in successfully',
    sessionToken,
    user: { id: user.id, email: user.email, username: user.username }
  });
});

// GET /api/auth/session
router.get('/session', (req, res) => {
  const token = req.headers['x-session-token'];
  if (!token || !activeSessions.has(token)) {
    return res.status(401).json({ error: 'No active session found' });
  }
  const session = activeSessions.get(token);
  res.json({ user: session });
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  const token = req.headers['x-session-token'];
  if (token) {
    activeSessions.delete(token);
  }
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/users
router.get('/users', (req, res) => {
  const list = db.users.map(u => ({
    id: u.id,
    email: u.email,
    username: u.username
  }));
  res.json(list);
});

module.exports = {
  router,
  activeSessions
};
