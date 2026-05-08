/* =============================================================================
 * db.js -- SQLite connection + migration runner.
 *
 * Uses better-sqlite3 (synchronous, very fast for small/medium workloads, no
 * connection pool to worry about). The DB file path is taken from the env var
 * DATABASE_PATH and defaults to ./data/sbg-tracker.db relative to the
 * backend folder. ":memory:" is supported for tests.
 * =============================================================================
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let _db = null;

function resolveDbPath(p) {
  if (!p || p === ':memory:') return p || ':memory:';
  if (path.isAbsolute(p)) return p;
  return path.resolve(__dirname, '..', p);
}

function getDb() {
  if (_db) return _db;
  const dbPath = resolveDbPath(process.env.DATABASE_PATH || './data/sbg-tracker.db');
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  _db = new Database(dbPath);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

function runMigrations(db = getDb()) {
  const migrationsDir = path.resolve(__dirname, '..', 'migrations');
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  // Track which migrations have run.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const already = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  const insert = db.prepare('INSERT INTO schema_migrations (name) VALUES (?)');
  for (const f of files) {
    if (already.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      insert.run(f);
    })();
    console.log(`[db] migration applied: ${f}`);
  }
}

// Helper: read a JSON column safely.
function parseJson(s, fallback = {}) {
  if (s == null || s === '') return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

module.exports = { getDb, closeDb, runMigrations, parseJson };
