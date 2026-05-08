/* =============================================================================
 * api.js -- Lightweight REST client for the SBG Tracker backend.
 *
 * Strategy: local-first with backend sync.
 *   - localStorage is always the source of truth for an immediate first paint.
 *   - On boot we ALSO fire an async GET /api/state that, if newer than the
 *     local cache, replaces it and triggers a re-render.
 *   - Every saveState() writes to localStorage immediately AND debounces a
 *     PUT /api/state to the server. If the server is unreachable, we just
 *     keep the localStorage copy -- the app stays fully functional offline.
 *   - Entity endpoints (POST /api/projects, etc.) are exposed on window.api
 *     for callers that want fine-grained server mutations instead of the
 *     coarse state blob.
 *
 * The API base URL is taken from the meta tag <meta name="api-base"> in
 * index.html. It defaults to "" (same origin) which works when the frontend
 * is served by the Express backend in dev.
 * =============================================================================
 */
(function () {
  const meta = document.querySelector('meta[name="api-base"]');
  const BASE = (meta && meta.content) || '';
  const ENABLED_META = document.querySelector('meta[name="api-enabled"]');
  const ENABLED = !ENABLED_META || ENABLED_META.content !== 'false';

  // Track sync health so the UI can show an offline indicator if it wants.
  const status = { online: false, lastSync: null, lastError: null };

  async function request(path, opts = {}) {
    if (!ENABLED) throw new Error('API disabled');
    const res = await fetch(BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${opts.method || 'GET'} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  const api = {
    status,
    enabled: ENABLED,

    // Coarse state-blob endpoint (matches frontend's existing single-blob model).
    getState: () => request('/api/state'),
    putState: (state) => request('/api/state', {
      method: 'PUT',
      body: JSON.stringify({ state }),
    }),

    // Entity endpoints -- thin wrappers around fetch.
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

  // Mark online status by attempting a health check, but don't block boot.
  api.health()
    .then(() => { status.online = true; status.lastError = null; })
    .catch((e) => { status.online = false; status.lastError = String(e); });

  window.api = api;
})();
