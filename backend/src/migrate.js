#!/usr/bin/env node
/* Standalone migration runner -- invoked by `npm run migrate`. */
require('dotenv').config();
const { getDb, runMigrations } = require('./db');

try {
  const db = getDb();
  runMigrations(db);
  console.log('[migrate] done');
} catch (err) {
  console.error('[migrate] failed:', err);
  process.exit(1);
}
