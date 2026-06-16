/* =============================================================================
 * sync-integration.js -- bolts the backend (local-first incremental sync) onto
 * the app WITHOUT touching app.js.
 *
 * The app's own code (app.js, generated from the single-file source) only
 * knows localStorage. This file layers the multi-user backend on top by:
 *   - wrapping the global saveState() so every save schedules a debounced,
 *     per-subdomain incremental PUT;
 *   - pulling the canonical state from the server on boot (304-aware);
 *   - resolving any deep-linked route once server data lands (router hook).
 *
 * It reads/writes the global `state` (window.state) and calls window.api
 * (api.js) + window.router (router.js). Load order: AFTER app.js, api.js,
 * realtime.js, router.js. Everything lives in one IIFE so it never collides
 * with app.js's top-level declarations.
 *
 * This is the piece the build-from-monolith pipeline relies on: regenerate
 * app.js from the single-file source as-is, and this file re-applies the whole
 * sync architecture externally.
 * =============================================================================
 */
(function () {
  const STORAGE_KEY = 'sbg_precon_tracker_v3';

  // Shared-config sync groups. Each is its own backend subdomain
  // (`settings:<group>`); keys NOT listed here (sidebarCollapsed, homeView,
  // currentUser, and all the active*/view-mode/calendar-cursor UI state) never
  // sync -- they're device-local and live only in localStorage.
  const SETTINGS_GROUPS = {
    branding: ['companyLogo'],
    calendar: ['holidays', 'skipWeekends', 'skipHolidays'],
    lists: ['stages', 'ballInCourtOptions', 'csiDivisions', 'sourceOptions', 'milestoneTypes'],
  };

  // If more than this many tasks changed in one project in one pass, it's
  // cheaper to replace the whole project than to fire that many per-task PUTs.
  const TASK_LEVEL_THRESHOLD = 8;

  // ---- debounce ------------------------------------------------------------
  let _apiSyncTimer = null;
  function scheduleApiSync() {
    if (!window.api || !window.api.enabled) return;
    if (_apiSyncTimer) clearTimeout(_apiSyncTimer);
    _apiSyncTimer = setTimeout(() => {
      _apiSyncTimer = null;
      performIncrementalSync();
    }, 150);
  }

  async function syncStateFromServer() {
    if (!window.api || !window.api.enabled) return false;
    try {
      const res = await window.api.getState();
      if (res && res.state && Object.keys(res.state).length > 0) {
        const local = { ...window.state };
        window.state = { ...local, ...res.state };
        window.state.bulkSelectionMode = false;
        window.state.bulkSelectedTaskIds = [];
        window.lastSyncedState = JSON.parse(JSON.stringify(window.state));
        return true;
      }
    } catch (err) {
      console.warn('Could not load state from backend (using local cache):', err.message);
    }
    return false;
  }

  // ---- incremental sync ----------------------------------------------------
  let _syncInFlight = false;
  let _syncQueued = false;

  async function performIncrementalSync() {
    if (!window.api || !window.api.enabled) return;
    if (!window.lastSyncedState) {
      window.lastSyncedState = JSON.parse(JSON.stringify(window.state));
      return;
    }
    if (_syncInFlight) { _syncQueued = true; return; }
    _syncInFlight = true;
    try {
      await _performIncrementalSyncInner();
    } finally {
      _syncInFlight = false;
      if (_syncQueued) { _syncQueued = false; scheduleApiSync(); }
    }
  }

  async function _performIncrementalSyncInner() {
    const state = window.state;
    const currentProjects = state.projects || [];
    const syncedProjects = window.lastSyncedState.projects || [];
    const currentProjMap = new Map(currentProjects.map(p => [p.id, p]));
    const syncedProjMap = new Map(syncedProjects.map(p => [p.id, p]));

    // Projects to delete
    for (const sp of syncedProjects) {
      if (!currentProjMap.has(sp.id)) {
        try {
          await window.api.deleteProjectState(sp.id);
          window.lastSyncedState.projects =
            (window.lastSyncedState.projects || []).filter(p => p.id !== sp.id);
        } catch (err) { handleSyncError(err); }
      }
    }

    // Projects to add / update (task-level diff)
    for (const cp of currentProjects) {
      const sp = syncedProjMap.get(cp.id);
      if (sp && JSON.stringify(cp) === JSON.stringify(sp)) continue;
      if (!sp) {
        const sentCopy = JSON.parse(JSON.stringify(cp));
        try {
          await window.api.putProjectState(sentCopy);
          const list = window.lastSyncedState.projects || (window.lastSyncedState.projects = []);
          list.push(sentCopy);
        } catch (err) { handleSyncError(err); }
        continue;
      }
      await syncProjectIncrementally(cp, sp);
    }

    // Team members diff
    if (JSON.stringify(state.teamMembers) !== JSON.stringify(window.lastSyncedState.teamMembers)) {
      const sentCopy = JSON.parse(JSON.stringify(state.teamMembers));
      try {
        await window.api.putTeamMembersState(sentCopy);
        window.lastSyncedState.teamMembers = sentCopy;
      } catch (err) { handleSyncError(err); }
    }

    // Templates diff
    if (JSON.stringify(state.taskTemplates) !== JSON.stringify(window.lastSyncedState.taskTemplates)) {
      const sentCopy = JSON.parse(JSON.stringify(state.taskTemplates));
      try {
        await window.api.putTemplatesState(sentCopy);
        window.lastSyncedState.taskTemplates = sentCopy;
      } catch (err) { handleSyncError(err); }
    }

    // Shared config, per-group subdomains
    for (const group of Object.keys(SETTINGS_GROUPS)) {
      const keys = SETTINGS_GROUPS[group];
      const payload = {};
      const changed = [];
      for (const key of keys) {
        if (JSON.stringify(state[key]) !== JSON.stringify(window.lastSyncedState[key])) {
          payload[key] = JSON.parse(JSON.stringify(state[key] === undefined ? null : state[key]));
          changed.push(key);
        }
      }
      if (!changed.length) continue;
      try {
        await window.api.putSettingsState(payload, group);
        for (const key of changed) window.lastSyncedState[key] = payload[key];
      } catch (err) { handleSyncError(err); }
    }

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  async function syncProjectIncrementally(cp, sp) {
    const cpTasks = cp.tasks || [];
    const spTasks = sp.tasks || [];
    const cpTaskMap = new Map(cpTasks.map(t => [t.id, t]));
    const spTaskMap = new Map(spTasks.map(t => [t.id, t]));

    const changedTasks = [];
    for (const t of cpTasks) {
      const old = spTaskMap.get(t.id);
      if (!old || JSON.stringify(t) !== JSON.stringify(old)) changedTasks.push(t);
    }
    const deletedTaskIds = [];
    for (const t of spTasks) {
      if (!cpTaskMap.has(t.id)) deletedTaskIds.push(t.id);
    }

    const cpMeta = { ...cp }; delete cpMeta.tasks; delete cpMeta.subBids;
    const spMeta = { ...sp }; delete spMeta.tasks; delete spMeta.subBids;
    const metaChanged = JSON.stringify(cpMeta) !== JSON.stringify(spMeta);

    if (changedTasks.length + deletedTaskIds.length > TASK_LEVEL_THRESHOLD) {
      const sentCopy = JSON.parse(JSON.stringify(cp));
      try {
        await window.api.putProjectState(sentCopy);
        replaceInLastSynced(sentCopy);
      } catch (err) { handleSyncError(err); }
      return;
    }

    const syncedProj = JSON.parse(JSON.stringify(sp));
    syncedProj.tasks = syncedProj.tasks || [];
    const syncedTaskMap = new Map(syncedProj.tasks.map(t => [t.id, t]));

    for (const t of changedTasks) {
      const sent = JSON.parse(JSON.stringify(t));
      try {
        await window.api.putTaskState(cp.id, sent);
        syncedTaskMap.set(sent.id, sent);
      } catch (err) { handleSyncError(err); }
    }
    for (const tid of deletedTaskIds) {
      try {
        await window.api.deleteTaskState(cp.id, tid);
        syncedTaskMap.delete(tid);
      } catch (err) { handleSyncError(err); }
    }
    if (metaChanged) {
      const sentMeta = JSON.parse(JSON.stringify(cpMeta));
      try {
        await window.api.putProjectMeta(sentMeta);
        Object.assign(syncedProj, sentMeta);
      } catch (err) { handleSyncError(err); }
    }

    syncedProj.tasks = Array.from(syncedTaskMap.values());
    if (Object.prototype.hasOwnProperty.call(cp, 'subBids')) {
      syncedProj.subBids = JSON.parse(JSON.stringify(cp.subBids));
    } else {
      delete syncedProj.subBids;
    }
    replaceInLastSynced(syncedProj);
  }

  function replaceInLastSynced(proj) {
    const list = window.lastSyncedState.projects || (window.lastSyncedState.projects = []);
    const idx = list.findIndex(p => p.id === proj.id);
    if (idx === -1) list.push(proj); else list[idx] = proj;
  }

  function handleSyncError(err) {
    if (err.status === 409 || err.status === 400) {
      console.warn('Sync conflict detected, server state applied:', err.message);
    } else {
      console.warn('Sync failed:', err.message);
    }
  }

  // Expose for realtime.js / debugging (api.js + realtime.js reference these
  // indirectly via window.state; nothing else needs them, but it's handy).
  window.scheduleApiSync = scheduleApiSync;
  window.syncStateFromServer = syncStateFromServer;
  window.performIncrementalSync = performIncrementalSync;

  // ---- hook saveState ------------------------------------------------------
  // The app's saveState() only writes localStorage. Wrap it so every save also
  // schedules a backend sync. Because saveState is a function-declaration
  // global, reassigning window.saveState also redirects the app's own bare
  // saveState() calls through this wrapper.
  function installSaveHook() {
    const orig = window.saveState;
    if (typeof orig !== 'function' || orig.__sbgSyncHooked) return;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      scheduleApiSync();
      return r;
    };
    wrapped.__sbgSyncHooked = true;
    window.saveState = wrapped;
  }

  // ---- boot ----------------------------------------------------------------
  // app.js (deferred, earlier in the document) has already run loadState() +
  // render() by the time this deferred script executes, so window.state is
  // populated. Mirror the original split app's boot tail here.
  function boot() {
    installSaveHook();
    if (typeof window.state === 'undefined') return;
    if (!window.api || !window.api.enabled) {
      if (window.router && typeof window.router.afterStateLoad === 'function') window.router.afterStateLoad();
      return;
    }
    if (!window.lastSyncedState) {
      window.lastSyncedState = JSON.parse(JSON.stringify(window.state));
    }
    syncStateFromServer().then(updated => {
      if (updated) {
        try { document.body.setAttribute('data-hours-enabled', window.state.hoursEnabled ? 'true' : 'false'); } catch (e) {}
        window.state.sidebarCollapsed = true;
        if (typeof renderCompanyLogo === 'function') renderCompanyLogo();
        if (typeof render === 'function') render();
      }
      if (window.router && typeof window.router.afterStateLoad === 'function') window.router.afterStateLoad();
    });
  }

  boot();
})();
