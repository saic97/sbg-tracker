/* =============================================================================
 * api.js -- REST client for the SBG Tracker backend, with bearer-token auth.
 *
 * Strategy: local-first with backend sync, gated by an optimistic-concurrency
 * version token.
 *   - localStorage stays the source of truth for instant first paint.
 *   - On boot we ALSO fire async GET /api/state; if newer, replace local +
 *     render. The GET response includes the current `version` -- we cache it
 *     on `api.stateVersion` and send it as `expectedVersion` on every PUT.
 *   - Every saveState() writes localStorage immediately AND debounces a
 *     PUT /api/state. On a successful PUT we update `api.stateVersion` to
 *     the value the server returns.
 *
 * Conflict handling (the whole point of versioning):
 *   - 409 VERSION_CONFLICT: another tab/user wrote since we loaded. We splice
 *     the server's current state into window.state, update version, render,
 *     and surface a banner so the user knows their last edit didn't land.
 *   - 409 DESTRUCTIVE_DELETE: the save would drop one or more existing
 *     projects. We prompt with the project NAMES so the user can recognize
 *     "oh that's the new project I added in another tab" and choose to
 *     reload (default) instead of force-deleting.
 *   - 400 EXPECTED_VERSION_REQUIRED: client sent no version. Treated like
 *     VERSION_CONFLICT -- typically means a stale cached bundle.
 *
 * Auth integration: every fetch attaches Authorization: Bearer <token> if
 * window.auth.token is set (managed by auth-ui.js). On 401, we clear the
 * session and reload, which re-shows the login overlay.
 *
 * Meta tags read at boot:
 *   <meta name="api-base">    -- backend URL (empty = same origin)
 *   <meta name="api-enabled"> -- "false" disables backend sync entirely
 * =============================================================================
 */
(function () {
  const meta = document.querySelector('meta[name="api-base"]');
  const BASE = (meta && meta.content) || '';
  const ENABLED_META = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !ENABLED_META || ENABLED_META.content !== 'false';

  const status = { online: false, lastSync: null, lastError: null };

  // The server-assigned monotonic version of the state we last saw. Updated
  // by getState(), putState() success, conflict responses, and the realtime
  // state:updated handler (see realtime.js).
  let _stateVersion = null;
  // We only want to surface the conflict banner once per occurrence; the
  // saveState debounce can fire multiple PUTs in flight and we don't want to
  // alert N times for the same underlying staleness.
  let _conflictBannerShown = false;
  let _destructivePromptOpen = false;

  function getToken() {
    return (window.auth && window.auth.token) || null;
  }

  async function request(path, opts = {}) {
    if (!ENABLED) throw new Error('API disabled');
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(BASE + path, { ...opts, headers });
    if (res.status === 401) {
      // Token expired or invalid -- clear and reload to trigger re-auth.
      if (window.auth && typeof window.auth.clearSession === 'function') {
        window.auth.clearSession();
      }
      // Don't reload during the very first sync (auth-ui handles the overlay).
      if (window.auth && window.auth.user) {
        location.reload();
      }
      throw new Error('not authenticated');
    }
    if (!res.ok) {
      // Parse the JSON body if any so callers can inspect `code` / `state`
      // without a second fetch. We still throw so the existing .catch() paths
      // continue to log; conflict handling reads err.status + err.body.
      const text = await res.text().catch(() => '');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      const err = new Error(`API ${opts.method || 'GET'} ${path} failed: ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  // --- conflict UI helpers ---------------------------------------------------
  // We render a sticky red banner at the top of the viewport rather than using
  // window.alert: alert() blocks all JS (including renders), and we want to
  // re-render the page with the server's fresh state behind the banner.
  function injectConflictStyles() {
    if (document.getElementById('sbg-conflict-style')) return;
    const css = `
      #sbg-conflict-banner {
        position: fixed; top: 0; left: 0; right: 0; z-index: 100000;
        background: #c8322b; color: #fff;
        font-family: 'Inter', system-ui, sans-serif; font-size: 14px;
        padding: 10px 16px; box-shadow: 0 2px 6px rgba(0,0,0,0.2);
        display: flex; align-items: center; gap: 12px;
      }
      #sbg-conflict-banner .sbg-conflict-msg { flex: 1; line-height: 1.35; }
      #sbg-conflict-banner button {
        background: #fff; color: #c8322b; border: 0; border-radius: 4px;
        padding: 6px 12px; font-weight: 600; cursor: pointer; font-size: 13px;
      }
      #sbg-conflict-banner button:hover { background: #f3f3f3; }
    `;
    const s = document.createElement('style');
    s.id = 'sbg-conflict-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function showConflictBanner(message) {
    injectConflictStyles();
    let el = document.getElementById('sbg-conflict-banner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sbg-conflict-banner';
      el.innerHTML = '<span class="sbg-conflict-msg"></span><button type="button">Dismiss</button>';
      document.body.appendChild(el);
      el.querySelector('button').addEventListener('click', () => {
        el.remove();
        _conflictBannerShown = false;
      });
    }
    el.querySelector('.sbg-conflict-msg').textContent = message;
    _conflictBannerShown = true;
  }

  // Splice the server's current state into the running app, preserving
  // transient UI flags the server doesn't own. Mirrors realtime.js's merge.
  function applyServerState(serverState) {
    if (!serverState || typeof window.state === 'undefined') return;
    const localUiFlags = {
      activeProjectId: window.state.activeProjectId,
      activeStageId: window.state.activeStageId,
      activeAssignee: window.state.activeAssignee,
      grouping: window.state.grouping,
      viewMode: window.state.viewMode,
      bulkSelectionMode: false,
      bulkSelectedTaskIds: [],
    };
    window.state = { ...window.state, ...serverState, ...localUiFlags };
    try { localStorage.setItem('sbg_precon_tracker_v3', JSON.stringify(window.state)); } catch (e) {}
    if (typeof window.render === 'function') window.render();
  }

  function handleVersionConflict(body) {
    if (body && typeof body.currentVersion === 'number') _stateVersion = body.currentVersion;
    if (body && body.state) applyServerState(body.state);
    if (_conflictBannerShown) return;
    showConflictBanner(
      "Your tab was out of date — we've refreshed it with the latest data. " +
      "Any change you just tried to save was NOT applied; please re-make it if needed."
    );
  }

  // Returns 'force' if the user wants to delete anyway, 'reload' otherwise.
  // Default (Cancel / dismiss) is 'reload' so a panicked enter-press is safe.
  function handleDestructiveDelete(body) {
    if (_destructivePromptOpen) return 'reload';
    _destructivePromptOpen = true;
    try {
      const names = (body.droppedProjects || []).map(p => '  • ' + (p.name || p.id)).join('\n');
      const msg =
        'This save would DELETE the following project(s) from the server:\n\n' +
        names + '\n\n' +
        'This usually means another tab/user added these and your view is out of date.\n\n' +
        'Click OK to RELOAD with the latest data (recommended).\n' +
        'Click Cancel to FORCE the save and delete those projects anyway.';
      // window.confirm is fine here -- it's exactly the modal+blocking semantics
      // we want, and the data-loss risk justifies a hard interruption.
      const reload = window.confirm(msg);
      if (reload) {
        if (body && typeof body.currentVersion === 'number') _stateVersion = body.currentVersion;
        if (body && body.state) applyServerState(body.state);
        return 'reload';
      }
      return 'force';
    } finally {
      _destructivePromptOpen = false;
    }
  }

  const api = {
    status, enabled: ENABLED,
    get stateVersion() { return _stateVersion; },
    setStateVersion(v) { if (typeof v === 'number') _stateVersion = v; },

    // Coarse state-blob endpoint
    getState: async () => {
      const r = await request('/api/state');
      if (r && typeof r.version === 'number') _stateVersion = r.version;
      return r;
    },
    putState: async (state, opts = {}) => {
      const body = {
        state,
        clientId: (window.realtime && window.realtime.clientId) || null,
        expectedVersion: _stateVersion,
      };
      if (opts.confirmDestructive) body.confirmDestructive = true;
      try {
        const r = await request('/api/state', { method: 'PUT', body: JSON.stringify(body) });
        if (r && typeof r.version === 'number') _stateVersion = r.version;
        return r;
      } catch (e) {
        const code = e && e.body && e.body.code;
        if ((e.status === 400 && code === 'EXPECTED_VERSION_REQUIRED') ||
            (e.status === 409 && code === 'VERSION_CONFLICT')) {
          handleVersionConflict(e.body);
        } else if (e.status === 409 && code === 'DESTRUCTIVE_DELETE') {
          const choice = handleDestructiveDelete(e.body);
          if (choice === 'force') {
            // Retry with the same blob, this time bypassing the guard. Use
            // the server's reported currentVersion so the version check passes.
            if (typeof e.body.currentVersion === 'number') _stateVersion = e.body.currentVersion;
            return api.putState(state, { confirmDestructive: true });
          }
          // 'reload': server state was applied; let the caller see the failure.
        }
        throw e;
      }
    },

    // Entity endpoints
    listProjects: () => request('/api/projects'),
    createProject: (data) => request('/api/projects', { method: 'POST', body: JSON.stringify(data) }),
    updateProject: (id, data) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteProject: (id) => request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listTasks: (projectId) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks`),
    createTask: (projectId, data) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks`, { method: 'POST', body: JSON.stringify(data) }),
    updateTask: (projectId, taskId, data) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTask: (projectId, taskId) => request(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' }),

    listTeamMembers: () => request('/api/team-members'),
    createTeamMember: (data) => request('/api/team-members', { method: 'POST', body: JSON.stringify(data) }),
    updateTeamMember: (id, data) => request(`/api/team-members/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTeamMember: (id) => request(`/api/team-members/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listStages: () => request('/api/stages'),
    putStages: (stages) => request('/api/stages', { method: 'PUT', body: JSON.stringify({ stages }) }),

    listTemplates: () => request('/api/templates'),
    createTemplate: (data) => request('/api/templates', { method: 'POST', body: JSON.stringify(data) }),
    updateTemplate: (id, data) => request(`/api/templates/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
    deleteTemplate: (id) => request(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),

    listHolidays: () => request('/api/holidays'),
    putHolidays: (holidays) => request('/api/holidays', { method: 'PUT', body: JSON.stringify({ holidays }) }),

    health: () => request('/api/health'),
  };

  api.health()
    .then(() => { status.online = true; status.lastError = null; })
    .catch((e) => { status.online = false; status.lastError = String(e); });

  window.api = api;
})();
