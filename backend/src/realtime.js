/* =============================================================================
 * realtime.js -- Socket.IO server for real-time multi-user sync + presence.
 *
 * Behavior:
 *   - On connect, the client sends `auth: { token }` (bearer token from /api/auth).
 *     We validate against the sessions table (re-using auth.js logic). Invalid
 *     -> disconnect with an error.
 *   - Authed clients all join one workspace-wide room called "workspace".
 *   - The server maintains a presence registry mapping socketId -> { user, activeProjectId }.
 *     Whenever someone joins/leaves/switches project, we broadcast `presence:list`
 *     with the full current list to everyone.
 *   - When the REST layer commits a `PUT /api/state`, it calls `broadcastStateChange(payload)`.
 *     The payload carries an optional `clientId` so the originator can skip
 *     re-applying its own broadcast.
 *
 * Events (server -> client):
 *   - presence:list      [{ userId, name, email, activeProjectId, since }]
 *   - state:updated      { state, byUserId, byUserName, clientId, ts }
 *   - error              { message }
 *
 * Events (client -> server):
 *   - presence:update    { activeProjectId }
 *   - editing:start      { taskId }    -- v2 stub, not broadcast for now
 *   - editing:end        { taskId }    -- v2 stub
 *
 * The Socket.IO instance is exposed via `attach(httpServer)` and shared via
 * `broadcastStateChange()` which is called from routes.js.
 * =============================================================================
 */
const { Server } = require('socket.io');
const { getDb } = require('./db');

let io = null;
const presence = new Map();  // socketId -> { userId, name, email, activeProjectId, since }

function lookupSessionInline(token) {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM sessions WHERE id=?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE id=?').run(token);
    return null;
  }
  getDb().prepare('UPDATE sessions SET last_used=? WHERE id=?').run(Date.now(), token);
  const user = getDb().prepare('SELECT id, email, name, role, disabled FROM users WHERE id=?').get(row.user_id);
  if (!user || user.disabled) return null;
  return { session: row, user };
}

function presenceList() {
  return Array.from(presence.values()).map(p => ({
    userId: p.userId, name: p.name, email: p.email,
    activeProjectId: p.activeProjectId, since: p.since,
  }));
}

function broadcastPresence() {
  if (!io) return;
  io.to('workspace').emit('presence:list', presenceList());
}

function attach(httpServer, opts = {}) {
  // CORS is handled by Express on REST. Socket.IO needs its own allowed origins.
  const origins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const corsOrigin = origins.includes('*') ? true : origins;
  io = new Server(httpServer, {
    cors: { origin: corsOrigin, credentials: false },
    path: '/socket.io',
    serveClient: true,  // serves /socket.io/socket.io.js for the browser client
    // WebSocket compression. Default is OFF, which means every `state:updated`
    // broadcast ships the full state blob (~700 KB in production) uncompressed
    // to every connected client. With permessage-deflate negotiated, that JSON
    // typically compresses ~10x. The 1 KB threshold avoids spending CPU on
    // tiny frames (presence pings, editing markers).
    perMessageDeflate: { threshold: 1024 },
    httpCompression: { threshold: 1024 },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    const ctx = lookupSessionInline(token);
    if (!ctx) return next(new Error('unauthorized'));
    socket.data.user = ctx.user;
    next();
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join('workspace');
    socket.join('user:' + user.id);   // per-user room for targeted notifications
    presence.set(socket.id, {
      userId: user.id, name: user.name || user.email, email: user.email,
      activeProjectId: null, since: Date.now(),
    });
    broadcastPresence();

    socket.on('presence:update', (data) => {
      const entry = presence.get(socket.id);
      if (!entry) return;
      entry.activeProjectId = (data && data.activeProjectId) || null;
      broadcastPresence();
    });

    socket.on('editing:start', () => { /* v2 */ });
    socket.on('editing:end',   () => { /* v2 */ });

    socket.on('disconnect', () => {
      presence.delete(socket.id);
      broadcastPresence();
    });
  });

  return io;
}

function broadcastStateChange({ state, byUserId, byUserName, clientId }) {
  if (!io) return;
  io.to('workspace').emit('state:updated', {
    state, byUserId, byUserName, clientId, ts: Date.now(),
  });
}

function getIo() { return io; }

function emitToUser(userId, event, payload) {
  if (!io) return;
  io.to('user:' + userId).emit(event, payload);
}

module.exports = { attach, broadcastStateChange, getIo, presenceList, emitToUser };
