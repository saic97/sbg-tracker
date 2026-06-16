/* =============================================================================
 * dataFixups.js -- One-time, idempotent data repairs run at server boot.
 *
 * externalizeDeliverableFiles: historical versions of the frontend stored
 * deliverable file uploads as base64 data: URLs INSIDE task JSON. That meant
 * every save of a project with attached files re-uploaded all of them (a
 * browser PUT body is never compressed), and every boot download carried
 * them too -- the main source of multi-MB sync packets.
 *
 * This fixup decodes each embedded file once, writes it to the attachments
 * storage (disk under data/uploads/), creates an attachments row, and
 * replaces the inline blob with a small `attachmentId` reference the
 * frontend resolves via GET /api/attachments/:id/download.
 *
 * Also scrubs table-backed domains (projects etc.) out of the kv 'state'
 * row, where old code kept a full redundant copy of the workspace.
 *
 * Safe to run on every boot: a kv flag short-circuits, and the per-row work
 * is itself idempotent (only data: URLs are touched).
 * =============================================================================
 */
const crypto = require('crypto');
const { getDb, parseJson } = require('./db');
const m = require('./models');
const storage = require('./storage');

const FLAG = 'fixup_deliverables_externalized_v1';

const DATA_URL_RE = /^data:([^;,]*);base64,(.*)$/s;

async function externalizeDeliverableFiles() {
  if (m.kv.get(FLAG)) return { migrated: 0, skipped: true };

  const db = getDb();
  const rows = db.prepare(
    "SELECT id, project_id, data FROM tasks WHERE data LIKE '%\"fileData\":\"data:%'"
  ).all();

  let migrated = 0;
  let failed = 0;
  for (const row of rows) {
    const data = parseJson(row.data, {});
    if (!Array.isArray(data.deliverables)) continue;
    let changed = false;
    for (const d of data.deliverables) {
      if (!d || typeof d.fileData !== 'string') continue;
      const match = DATA_URL_RE.exec(d.fileData);
      if (!match) continue;
      try {
        const buf = Buffer.from(match[2], 'base64');
        const key = storage.generateKey(d.fileName || 'deliverable');
        await storage.put(key, buf);
        const id = crypto.randomBytes(12).toString('hex');
        m.attachments.create({
          id,
          project_id: row.project_id || null,
          task_id: row.id,
          filename: d.fileName || 'deliverable',
          content_type: d.fileType || match[1] || 'application/octet-stream',
          size_bytes: buf.length,
          storage_key: key,
          uploaded_by: null,
        });
        d.attachmentId = id;
        d.fileData = '';
        changed = true;
        migrated++;
      } catch (e) {
        failed++;
        console.warn('[fixup] could not externalize deliverable on task', row.id, '-', e.message);
      }
    }
    if (changed) {
      db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
    }
  }

  // Scrub redundant table-backed copies (incl. any embedded files) out of
  // the kv 'state' row.
  const blob = m.kv.get('state');
  if (blob && typeof blob === 'object') {
    m.kv.set('state', m.stripTableBackedKeys(blob));
  }

  // Only latch the flag when nothing failed, so a transient error (e.g.
  // disk full) gets retried on the next restart.
  if (failed === 0) m.kv.set(FLAG, { at: Date.now(), migrated });
  if (migrated || failed) {
    console.log(`[fixup] deliverable files externalized: ${migrated} migrated, ${failed} failed`);
  }
  return { migrated, failed };
}

async function runAll() {
  try {
    await externalizeDeliverableFiles();
  } catch (e) {
    console.warn('[fixup] externalizeDeliverableFiles failed:', e.message);
  }
}

module.exports = { runAll, externalizeDeliverableFiles };
