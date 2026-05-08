/* =============================================================================
 * auth.js -- Email/password auth with bearer tokens.
 *
 * Endpoints (mounted at /api/auth):
 *   POST /signup    { email, password, name? } -> 201 { user, token }
 *   POST /login     { email, password }        -> 200 { user, token }
 *   POST /logout                                -> 204
 *   GET  /me                                    -> 200 { user } | 401
 *
 * Middleware:
 *   requireAuth -- 401s if no Authorization: Bearer <token> or token invalid.
 *   optionalAuth -- attaches req.user if token is valid, otherwise continues.
 *
 * Env vars:
 *   ALLOW_SIGNUP=true|false   (default true). When false, /signup 403s
 *                              UNLESS the users table is empty (first admin).
 *   SESSION_TTL_DAYS=30        (default 30 days)
 * =============================================================================
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { getDb } = require('./db');
const m = require('./models');

const SESSION_TTL_MS = (parseInt(process.env.SESSION_TTL_DAYS || '30', 10)) * 24 * 60 * 60 * 1000;

function uid() { return Date.now().toString(36) + crypto.randomBytes(6).toString('hex'); }
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function publicUser(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE lower(email)=lower(?)').get(email);
}
function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id=?').get(id);
}

function countUsers() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function createSession(userId, req) {
  const token = newToken();
  const expires = Date.now() + SESSION_TTL_MS;
  getDb().prepare(`INSERT INTO sessions (id, user_id, user_agent, ip, expires_at, last_used)
                   VALUES (?, ?, ?, ?, ?, ?)`)
         .run(token, userId, (req.get && req.get('user-agent')) || '', req.ip || '', expires, Date.now());
  return { token, expires };
}

function lookupSession(token) {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM sessions WHERE id=?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE id=?').run(token);
    return null;
  }
  // Refresh last_used (best-effort)
  getDb().prepare('UPDATE sessions SET last_used=? WHERE id=?').run(Date.now(), token);
  const user = getUserById(row.user_id);
  if (!user || user.disabled) return null;
  return { session: row, user };
}

function extractBearer(req) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

// --- Middleware ---
function requireAuth(req, res, next) {
  const token = extractBearer(req);
  const ctx = lookupSession(token);
  if (!ctx) return res.status(401).json({ error: 'authentication required' });
  req.user = ctx.user;
  req.session = ctx.session;
  next();
}

function optionalAuth(req, res, next) {
  const token = extractBearer(req);
  const ctx = lookupSession(token);
  if (ctx) {
    req.user = ctx.user;
    req.session = ctx.session;
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  next();
}

// --- Routes ---
function buildRouter() {
  const r = express.Router();

  r.post('/signup', async (req, res) => {
    try {
      const { email, password, name } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 chars' });

      const allow = (process.env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';
      const isFirstUser = countUsers() === 0;
      if (!allow && !isFirstUser) return res.status(403).json({ error: 'signup disabled by admin' });

      if (getUserByEmail(email)) return res.status(409).json({ error: 'email already registered' });

      const id = uid();
      const password_hash = await bcrypt.hash(password, 10);
      const role = isFirstUser ? 'admin' : 'member';
      const ts = Date.now();
      getDb().prepare(`INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)`)
             .run(id, email.toLowerCase().trim(), password_hash, name || '', role, ts, ts);
      const { token, expires } = createSession(id, req);
      const user = getUserById(id);
      m.audit('signup', 'user', id, { email: user.email, role });
      res.status(201).json({ user: publicUser(user), token, expiresAt: expires });
    } catch (err) {
      console.error('[auth] signup failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body || {};
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      const user = getUserByEmail(email);
      if (!user || user.disabled) return res.status(401).json({ error: 'invalid credentials' });
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: 'invalid credentials' });
      const { token, expires } = createSession(user.id, req);
      m.audit('login', 'user', user.id);
      res.json({ user: publicUser(user), token, expiresAt: expires });
    } catch (err) {
      console.error('[auth] login failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  r.post('/logout', (req, res) => {
    const token = extractBearer(req);
    if (token) getDb().prepare('DELETE FROM sessions WHERE id=?').run(token);
    res.status(204).end();
  });

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  // Allow-signup status (so the login UI can show/hide the signup form).
  r.get('/config', (req, res) => {
    const allow = (process.env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';
    const isFirstUser = countUsers() === 0;
    res.json({ signupEnabled: allow || isFirstUser, isFirstUser });
  });

  return r;
}

module.exports = { buildRouter, requireAuth, optionalAuth, requireAdmin, publicUser };
