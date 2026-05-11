/* =============================================================================
 * admin-panel.js -- Admin-only UI for user management + audit feed.
 *
 * Injects an "⚙ Admin" button (top-right header) that only appears when
 * window.auth.user.role === 'admin'. Clicking it opens a modal with two
 * tabs:
 *   - Users:     editable roster (name / role / disabled / delete)
 *   - Activity:  paginated audit log with filters (action, entity, user)
 * =============================================================================
 */
(function () {
  const apiBaseMeta = document.querySelector('meta[name="api-base"]');
  const BASE = (apiBaseMeta && apiBaseMeta.content) || '';
  const apiEnabledMeta = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !apiEnabledMeta || apiEnabledMeta.content !== 'false';

  function isAdmin() {
    return !!(window.auth && window.auth.user && window.auth.user.role === 'admin');
  }

  function injectStyles() {
    const css = `
      #ap-trigger {
        position: fixed; top: 14px; right: 310px; z-index: 90;
        background: #2563a8; color: #fff; border: 0; padding: 8px 14px;
        border-radius: 4px; font-weight: 700; font-size: 12px; cursor: pointer;
        font-family: 'Inter', system-ui, sans-serif; letter-spacing: 0.04em;
        box-shadow: 0 2px 6px rgba(37,99,168,0.25); display: none;
      }
      #ap-trigger.visible { display: inline-flex; }
      #ap-trigger:hover { background: #1d4f8a; }
      #ap-modal {
        position: fixed; inset: 0; background: rgba(10,37,64,0.72);
        z-index: 9000; display: none; align-items: center; justify-content: center;
        font-family: 'Inter', system-ui, sans-serif;
      }
      #ap-modal.active { display: flex; }
      .ap-card {
        background: #fff; border-radius: 8px; width: 900px; max-width: 96vw;
        max-height: 88vh; overflow: hidden; display: flex; flex-direction: column;
        box-shadow: 0 20px 60px rgba(0,0,0,0.4);
      }
      .ap-card header {
        padding: 16px 24px; border-bottom: 1px solid #dbdfe5;
        display: flex; align-items: center; justify-content: space-between;
      }
      .ap-card header h2 { margin: 0; font-size: 18px; color: #0a2540; }
      .ap-close { border: 0; background: transparent; font-size: 22px; cursor: pointer; color: #6b7687; }
      .ap-tabs { display: flex; gap: 4px; padding: 10px 24px 0; border-bottom: 1px solid #edeff3; background: #f8f9fb; }
      .ap-tabs button {
        border: 0; background: transparent; padding: 8px 14px; font-weight: 600; cursor: pointer;
        color: #6b7687; border-bottom: 2px solid transparent; font-size: 13px;
      }
      .ap-tabs button.active { color: #0a2540; border-bottom-color: #c8322b; }
      .ap-body { padding: 16px 24px; overflow: auto; flex: 1; }
      .ap-pane { display: none; }
      .ap-pane.active { display: block; }
      table.ap-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      table.ap-table th, table.ap-table td { padding: 8px 6px; border-bottom: 1px solid #edeff3; text-align: left; }
      table.ap-table th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7687; }
      table.ap-table tr:hover td { background: #f8f9fb; }
      .ap-role-select, .ap-input { padding: 4px 6px; border: 1px solid #dbdfe5; border-radius: 3px; font-size: 13px; font-family: inherit; }
      .ap-action-btn { border: 1px solid #dbdfe5; background: #fff; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 12px; }
      .ap-action-btn.danger { color: #c8322b; }
      .ap-action-btn.danger:hover { background: #fde4e2; }
      .ap-status { font-size: 12px; color: #6b7687; margin-top: 8px; min-height: 18px; }
      .ap-status.error { color: #c8322b; }
      .ap-filters { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
      .ap-filters label { font-size: 11px; color: #6b7687; text-transform: uppercase; letter-spacing: 0.04em; }
      .ap-paging { margin-top: 12px; display: flex; gap: 6px; align-items: center; justify-content: center; }
      .ap-audit-row { display: grid; grid-template-columns: 130px 95px 110px 1fr 170px; gap: 10px; padding: 8px 0; border-bottom: 1px solid #edeff3; font-size: 12px; }
      .ap-audit-action { font-weight: 700; }
      .ap-audit-action.create { color: #2e7d52; }
      .ap-audit-action.update { color: #2563a8; }
      .ap-audit-action.delete { color: #c8322b; }
      .ap-audit-action.upload { color: #7b4397; }
      .ap-audit-action.login { color: #6b7687; }
      .ap-audit-action.signup { color: #d4a017; }
      .ap-audit-payload { color: #6b7687; font-family: 'JetBrains Mono', monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ap-pill { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px; background: #edeff3; color: #2d3a4d; }
      .ap-pill.admin { background: #fde4e2; color: #c8322b; }
      .ap-pill.estimator { background: #e3efff; color: #2563a8; }
      .ap-pill.viewer { background: #ece1f3; color: #7b4397; }
    `;
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function injectMarkup() {
    const trigger = document.createElement('button');
    trigger.id = 'ap-trigger';
    trigger.innerHTML = '⚙ Admin';
    trigger.title = 'User management + audit feed (admin only)';
    trigger.addEventListener('click', open);
    document.body.appendChild(trigger);

    const modal = document.createElement('div');
    modal.id = 'ap-modal';
    modal.innerHTML = `
      <div class="ap-card">
        <header>
          <h2>⚙ Admin</h2>
          <button class="ap-close" type="button" aria-label="Close">&times;</button>
        </header>
        <div class="ap-tabs">
          <button type="button" data-tab="users" class="active">Users</button>
          <button type="button" data-tab="audit">Activity</button>
        </div>
        <div class="ap-body">
          <div class="ap-pane active" id="ap-pane-users">
            <table class="ap-table">
              <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th></th></tr></thead>
              <tbody id="ap-users-tbody"><tr><td colspan="6">Loading…</td></tr></tbody>
            </table>
            <div class="ap-status" id="ap-users-status"></div>
          </div>
          <div class="ap-pane" id="ap-pane-audit">
            <div class="ap-filters">
              <label>Action <select class="ap-input" id="ap-filter-action">
                <option value="">all</option>
                <option>create</option><option>update</option><option>delete</option>
                <option>upload</option><option>login</option><option>signup</option>
                <option>state-put</option><option>ai-extract</option>
              </select></label>
              <label>Entity <select class="ap-input" id="ap-filter-entity">
                <option value="">all</option>
                <option>project</option><option>task</option><option>user</option>
                <option>attachment</option><option>state</option><option>setting</option>
              </select></label>
              <button class="ap-action-btn" id="ap-filter-apply" type="button">Apply</button>
              <button class="ap-action-btn" id="ap-filter-reset" type="button">Reset</button>
            </div>
            <div id="ap-audit-list">Loading…</div>
            <div class="ap-paging">
              <button class="ap-action-btn" id="ap-audit-prev" type="button">‹ Newer</button>
              <span id="ap-audit-pageinfo" style="font-size:12px;color:#6b7687;"></span>
              <button class="ap-action-btn" id="ap-audit-next" type="button">Older ›</button>
            </div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.querySelector('.ap-close').addEventListener('click', close);

    modal.querySelectorAll('.ap-tabs button').forEach(b => {
      b.addEventListener('click', () => {
        modal.querySelectorAll('.ap-tabs button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        modal.querySelectorAll('.ap-pane').forEach(p => p.classList.remove('active'));
        modal.querySelector('#ap-pane-' + b.dataset.tab).classList.add('active');
        if (b.dataset.tab === 'audit') loadAudit();
      });
    });
    document.getElementById('ap-filter-apply').addEventListener('click', () => { auditOffset = 0; loadAudit(); });
    document.getElementById('ap-filter-reset').addEventListener('click', () => {
      document.getElementById('ap-filter-action').value = '';
      document.getElementById('ap-filter-entity').value = '';
      auditOffset = 0;
      loadAudit();
    });
    document.getElementById('ap-audit-prev').addEventListener('click', () => {
      auditOffset = Math.max(0, auditOffset - auditLimit); loadAudit();
    });
    document.getElementById('ap-audit-next').addEventListener('click', () => {
      auditOffset += auditLimit; loadAudit();
    });
  }

  function open() {
    document.getElementById('ap-modal').classList.add('active');
    loadUsers();
  }
  function close() { document.getElementById('ap-modal').classList.remove('active'); }

  function authHeader() { return { 'Authorization': 'Bearer ' + (window.auth && window.auth.token) }; }
  async function api(path, opts = {}) {
    const r = await fetch(BASE + path, { ...opts, headers: { ...authHeader(), 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || ('status ' + r.status));
    }
    if (r.status === 204) return null;
    return r.json();
  }

  async function loadUsers() {
    const tbody = document.getElementById('ap-users-tbody');
    const status = document.getElementById('ap-users-status');
    status.classList.remove('error'); status.textContent = '';
    try {
      const users = await api('/api/admin/users');
      tbody.innerHTML = users.map(u => `
        <tr data-id="${escapeAttr(u.id)}">
          <td><input class="ap-input ap-name" value="${escapeAttr(u.name || '')}" placeholder="(no name)"></td>
          <td>${escapeHtml(u.email)}</td>
          <td>
            <select class="ap-role-select">
              ${['admin','estimator','viewer'].map(r => `<option value="${r}" ${r===u.role?'selected':''}>${r}</option>`).join('')}
            </select>
          </td>
          <td><label style="font-size:12px;"><input type="checkbox" class="ap-disabled" ${u.disabled?'checked':''}> disabled</label></td>
          <td style="font-size:11px;color:#6b7687;">${new Date(u.created_at).toLocaleDateString()}</td>
          <td>
            <button class="ap-action-btn ap-save" type="button">Save</button>
            <button class="ap-action-btn danger ap-delete" type="button">Delete</button>
          </td>
        </tr>
      `).join('');
      tbody.querySelectorAll('tr').forEach(tr => {
        const id = tr.dataset.id;
        tr.querySelector('.ap-save').addEventListener('click', async () => {
          status.classList.remove('error');
          try {
            const body = {
              name: tr.querySelector('.ap-name').value,
              role: tr.querySelector('.ap-role-select').value,
              disabled: tr.querySelector('.ap-disabled').checked,
            };
            await api('/api/admin/users/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify(body) });
            status.textContent = 'Saved.';
          } catch (e) { status.classList.add('error'); status.textContent = e.message; }
        });
        tr.querySelector('.ap-delete').addEventListener('click', async () => {
          if (!confirm('Delete this user? Their sessions will be revoked.')) return;
          status.classList.remove('error');
          try {
            await api('/api/admin/users/' + encodeURIComponent(id), { method: 'DELETE' });
            loadUsers();
            status.textContent = 'Deleted.';
          } catch (e) { status.classList.add('error'); status.textContent = e.message; }
        });
      });
    } catch (e) {
      tbody.innerHTML = `<tr><td colspan="6">Error: ${escapeHtml(e.message)}</td></tr>`;
    }
  }

  let auditOffset = 0, auditLimit = 50, auditTotal = 0;
  async function loadAudit() {
    const listEl = document.getElementById('ap-audit-list');
    const info = document.getElementById('ap-audit-pageinfo');
    listEl.textContent = 'Loading…';
    const params = new URLSearchParams({ limit: String(auditLimit), offset: String(auditOffset) });
    const a = document.getElementById('ap-filter-action').value;
    const e = document.getElementById('ap-filter-entity').value;
    if (a) params.set('action', a);
    if (e) params.set('entity', e);
    try {
      const data = await api('/api/admin/audit-log?' + params.toString());
      auditTotal = data.total;
      if (!data.items.length) {
        listEl.innerHTML = '<div style="padding:18px;text-align:center;color:#9ba4b0;">No activity matching the current filters.</div>';
      } else {
        listEl.innerHTML = data.items.map(it => {
          const when = new Date(it.ts).toLocaleString();
          const who = it.user ? (it.user.name || it.user.email) : (it.user_id ? '(user ' + it.user_id.slice(0,6) + ')' : 'system');
          const payloadText = it.payload ? JSON.stringify(it.payload) : '';
          return `
            <div class="ap-audit-row">
              <div>${escapeHtml(when)}</div>
              <div><span class="ap-audit-action ${escapeAttr(it.action)}">${escapeHtml(it.action)}</span></div>
              <div>${escapeHtml(it.entity || '')}${it.entity_id ? ` <span style="color:#9ba4b0;">${escapeHtml(String(it.entity_id).slice(0,8))}</span>` : ''}</div>
              <div class="ap-audit-payload" title="${escapeAttr(payloadText)}">${escapeHtml(payloadText)}</div>
              <div>${escapeHtml(who)}</div>
            </div>
          `;
        }).join('');
      }
      info.textContent = `${auditOffset + 1}–${auditOffset + data.items.length} of ${data.total}`;
    } catch (err) {
      listEl.innerHTML = '<div style="color:#c8322b;padding:18px;">' + escapeHtml(err.message) + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }

  function updateVisibility() {
    const btn = document.getElementById('ap-trigger');
    if (!btn) return;
    btn.classList.toggle('visible', isAdmin());
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (!ENABLED) return;
    injectStyles();
    injectMarkup();
    // Re-check admin visibility periodically (auth.user might land slightly after DOMContentLoaded).
    setInterval(updateVisibility, 1000);
  });
})();
