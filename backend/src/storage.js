/* =============================================================================
 * storage.js -- File storage abstraction.
 *
 * v1: disk-backed under <DB_DIR>/uploads/. Swappable to S3 later by replacing
 * the implementation; the public surface (put/getStream/exists/size/remove)
 * stays stable.
 *
 * Storage keys are URL-safe and prefixed with a timestamp for natural sort
 * order. Original filenames are stored in the DB, not the key.
 * =============================================================================
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function rootDir() {
  // Resolve sibling-of-DB-file path. DATABASE_PATH is set by env or db.js default.
  const dbPath = process.env.DATABASE_PATH || path.resolve(__dirname, '..', 'data', 'sbg-tracker.db');
  if (dbPath === ':memory:') {
    // For tests: keep it under the OS temp dir so it gets cleaned up.
    return path.join(require('os').tmpdir(), 'sbg-tracker-uploads-' + process.pid);
  }
  const dir = path.dirname(path.isAbsolute(dbPath) ? dbPath : path.resolve(__dirname, '..', dbPath));
  return path.join(dir, 'uploads');
}

function ensureRoot() {
  const r = rootDir();
  if (!fs.existsSync(r)) fs.mkdirSync(r, { recursive: true });
  return r;
}

function generateKey(originalFilename) {
  const safe = String(originalFilename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(6).toString('hex');
  return `${ts}-${rand}-${safe}`;
}

async function put(key, buffer) {
  const root = ensureRoot();
  const dst = path.join(root, key);
  await fs.promises.writeFile(dst, buffer);
  return dst;
}

function getStream(key) {
  return fs.createReadStream(path.join(rootDir(), key));
}

function exists(key) {
  try { return fs.existsSync(path.join(rootDir(), key)); } catch { return false; }
}

function size(key) {
  try { return fs.statSync(path.join(rootDir(), key)).size; } catch { return 0; }
}

async function remove(key) {
  try { await fs.promises.unlink(path.join(rootDir(), key)); } catch {}
}

module.exports = { rootDir, generateKey, put, getStream, exists, size, remove };
