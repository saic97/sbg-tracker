/* =============================================================================
 * api.js -- REST client for the SBG Tracker backend, with bearer-token auth.
 *
 * Strategy: local-first with backend sync.
 *   - localStorage stays the source of truth for instant first paint.
 *   - On boot we ALSO fire async GET /api/state; if newer, replace local + render.
 *   - Every saveState() writes localStorage immediately AND debounces a
 *     PUT /api/state (auth required). Failures are logged + dropped.
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
      const text = await res.text().catch(() => '');
      throw new Error(`API ${opts.method || 'GET'} ${path} failed: ${res.status} ${text}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res.text();
  }

  const api = {
    status, enabled: ENABLED,

    // Coarse state-blob endpoint
    getState: () => request('/api/state'),
    putState: (state) => request('/api/state', { method: 'PUT', body: JSON.stringify({ state, clientId: (window.realtime && window.realtime.clientId) || null }) }),

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
