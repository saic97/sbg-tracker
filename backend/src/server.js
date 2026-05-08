/* =============================================================================
 * server.js -- Express bootstrap.
 *
 * Boots the HTTP server, runs migrations, mounts the REST router under /api,
 * and (optionally) serves the frontend as static files. CORS origins, port,
 * DB path, and static dir all come from environment variables -- see
 * .env.example.
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

  // CORS
  const origins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  app.use(cors({
    origin: origins.includes('*') ? true : origins,
    credentials: false,
  }));

  // Body parser w/ generous limit so the state-blob PUT works even when projects
  // accumulate a few MB worth of nested data.
  app.use(express.json({ limit: '25mb' }));

  // Request logging (skip in tests).
  if (process.env.NODE_ENV !== 'test') {
    app.use(morgan('dev'));
  }

  // Migrations always run on boot -- safe because they're idempotent.
  runMigrations(getDb());

  // REST API
  app.use('/api', buildRouter());

  // Static frontend (optional)
  const staticDir = process.env.STATIC_DIR ?? '../frontend';
  if (staticDir && staticDir.length > 0) {
    const abs = path.isAbsolute(staticDir) ? staticDir : path.resolve(__dirname, '..', staticDir);
    if (fs.existsSync(abs)) {
      app.use(express.static(abs));
      // SPA fallback: anything that isn't /api and isn't a real file -> index.html
      app.get(/^(?!\/api).*/, (req, res, next) => {
        const indexPath = path.join(abs, 'index.html');
        if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
        next();
      });
    } else {
      console.warn(`[server] STATIC_DIR ${abs} doesn't exist -- skipping static serving`);
    }
  }

  // 404
  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  // Error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    console.error('[server]', err);
    res.status(500).json({ error: err.message || 'internal error' });
  });

  return app;
}

if (require.main === module) {
  const port = parseInt(process.env.PORT || '3001', 10);
  const app = buildApp();
  app.listen(port, () => {
    console.log(`[server] SBG Tracker API listening on http://localhost:${port}`);
    console.log(`[server] DB: ${process.env.DATABASE_PATH || './data/sbg-tracker.db'}`);
    console.log(`[server] CORS: ${process.env.CORS_ORIGINS || '*'}`);
  });
}

module.exports = { buildApp };
