/* =============================================================================
 * server.js -- Express bootstrap with Socket.IO realtime.
 * =============================================================================
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');

const { getDb, runMigrations } = require('./db');
const { buildRouter } = require('./routes');

function buildApp() {
  const app = express();

  const origins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: origins.includes('*') ? true : origins,
    credentials: false,
  }));

  app.use(express.json({ limit: '25mb' }));

  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  runMigrations(getDb());

  app.use('/api', buildRouter());

  const staticDir = process.env.STATIC_DIR ?? '../frontend';
  if (staticDir && staticDir.length > 0) {
    const abs = path.isAbsolute(staticDir) ? staticDir : path.resolve(__dirname, '..', staticDir);
    if (fs.existsSync(abs)) {
      app.use(express.static(abs));
      app.get(/^(?!\/api).*/, (req, res, next) => {
        const indexPath = path.join(abs, 'index.html');
        if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
        next();
      });
    } else {
      console.warn(`[server] STATIC_DIR ${abs} doesn't exist -- skipping static serving`);
    }
  }

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('[server]', err);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: err.message || 'internal error' });
  });

  return app;
}

function buildServer() {
  const http = require('http');
  const { attach: attachRealtime } = require('./realtime');
  const app = buildApp();
  const httpServer = http.createServer(app);
  attachRealtime(httpServer);
  return { app, httpServer };
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3001', 10);
  const { httpServer } = buildServer();
  httpServer.listen(port, () => {
    console.log(`[server] SBG Tracker API listening on http://localhost:${port}`);
    console.log(`[server] DB: ${process.env.DATABASE_PATH || './data/sbg-tracker.db'}`);
    console.log(`[server] CORS: ${process.env.CORS_ORIGINS || '*'}`);
    console.log(`[server] Socket.IO ready on /socket.io`);
    try {
      const { startAutoPoller } = require('./bidIntake');
      if (startAutoPoller && startAutoPoller()) console.log('[server] Bid intake inbox poller started');
    } catch (err) {
      console.warn('[server] Bid intake poller not started:', err.message);
    }
  });
}

module.exports = { buildApp, buildServer };
