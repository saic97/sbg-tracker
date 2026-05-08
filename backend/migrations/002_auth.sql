-- =============================================================================
-- 002_auth.sql -- Users + sessions for multi-user auth.
--
-- Auth model:
--   - Email + bcrypt password (SSO can be added later as parallel auth provider).
--   - Bearer tokens stored in `sessions` table; sent by the client as
--     `Authorization: Bearer <token>` header.
--   - First user to sign up becomes admin. After that, the ALLOW_SIGNUP env
--     var on the server controls whether further self-signup is allowed.
--   - All workspace data (projects, tasks, etc.) is shared across users --
--     this matches the original single-user tool's behavior. The audit_log
--     records who did what.
-- =============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'member',     -- 'admin' | 'member'
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  updated_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                      -- 256-bit random token, hex-encoded
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent  TEXT,
  ip          TEXT,
  expires_at  INTEGER NOT NULL,                      -- ms epoch
  created_at  INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  last_used   INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Add user_id to audit_log so we can attribute writes.
-- (Existing rows keep NULL.)
ALTER TABLE audit_log ADD COLUMN user_id TEXT;
