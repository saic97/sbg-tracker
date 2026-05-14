-- =============================================================================
-- 007_state_versioning.sql -- Optimistic concurrency + rolling snapshots for
-- the coarse /api/state endpoint.
--
-- Why this exists:
--   A stale browser tab (cached older app build) used to be able to PUT its
--   old localStorage snapshot to /api/state. saveStateBlob() does
--   `DELETE FROM projects; DELETE FROM tasks;` and re-inserts from the blob,
--   so anything added since the stale tab booted got silently wiped --
--   including, in the May 2026 incident, a real client project (City of FTW).
--
-- Two new defenses, both checked before any DELETE runs:
--   1. expectedVersion -- monotonic counter. PUTs that don't match the
--      current server version are rejected with 409 VERSION_CONFLICT. Stored
--      here in key_value (no new column needed).
--   2. destructive-delete guard -- if the incoming projects array would drop
--      any currently-existing project id, refuse with 409 DESTRUCTIVE_DELETE
--      unless the caller explicitly opts in with confirmDestructive=true.
--
-- And one new safety net for future incidents:
--   3. state_snapshots -- every successful PUT writes the full state blob to
--      this table. saveStateBlob keeps the most recent ~50 (rotation done in
--      app code, not a trigger, so the limit can be tuned without a migration).
--      Recovery is now: SELECT blob FROM state_snapshots ORDER BY id DESC LIMIT 1.
-- =============================================================================

-- Initialize the version counter to 0 so the very first PUT (with
-- expectedVersion=0) succeeds. saveStateBlob upserts this row on every save.
INSERT OR IGNORE INTO key_value (key, value, updated_at)
  VALUES ('state_version', '0', datetime('now'));

CREATE TABLE IF NOT EXISTS state_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version       INTEGER NOT NULL,
  ts            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER) * 1000),
  user_id       TEXT,                  -- who triggered the PUT (nullable)
  project_count INTEGER,
  task_count    INTEGER,
  blob          TEXT NOT NULL          -- JSON; the entire state as PUT
);

CREATE INDEX IF NOT EXISTS idx_state_snapshots_ts      ON state_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_state_snapshots_version ON state_snapshots(version);
