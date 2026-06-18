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
    // Who the team lead is (drives realtime.js edit-popup routing: only the lead
    // sees everyone's edits; everyone else sees only the lead's). Shared, synced.
    team: ['teamLead'],
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

  // ---- import override -----------------------------------------------------
  // The app's applyImport() (app.js) replaces/merges window.state, calls
  // saveState(), then reloads the page ~250ms later. With the backend enabled
  // that RACES the debounced per-subdomain sync: the reload fires before the
  // upload finishes, boot() refetches the server's OLD copy, and the import is
  // silently lost -- "I import, refresh, and it goes back to the old data."
  // A wholesale import is also the one case the per-task incremental diff
  // handles badly (replacing every project at once can 404 / trip the
  // destructive-delete guard mid-stream).
  //
  // Replace applyImport with a backend-aware version: build the same new state,
  // push it ATOMICALLY via PUT /api/state (confirmDestructive), WAIT for the
  // server to confirm, reset the sync baseline, and only THEN reload.
  function installImportOverride() {
    if (!window.api || !window.api.enabled) return;
    window.applyImport = async function (mode) {
      const imported = window._pendingImportState;
      if (!imported) {
        alert('No import data available. Try again.');
        if (typeof window.closeImportConfirm === 'function') window.closeImportConfirm();
        return;
      }
      if (mode === 'replace') {
        const ok = confirm('This REPLACES all live data on the server (for everyone) with this backup. Current projects, tasks, templates and settings will be lost. Continue?');
        if (!ok) return;
      }
      try {
        // 1) Build the new local state exactly like app.js's applyImport does.
        if (mode === 'replace') {
          Object.keys(window.state).forEach(k => { delete window.state[k]; });
          Object.keys(imported).forEach(k => { window.state[k] = imported[k]; });
        } else {
          if (typeof window._mergeImportedArrays === 'function') {
            window._mergeImportedArrays(window.state, imported, 'projects', 'id');
            window._mergeImportedArrays(window.state, imported, 'masterTaskTemplates', 'id');
            window._mergeImportedArrays(window.state, imported, 'teamMembers', 'name');
          }
          if (Array.isArray(imported.teamHolidays)) {
            const ex = new Set(window.state.teamHolidays || []);
            imported.teamHolidays.forEach(h => ex.add(h));
            window.state.teamHolidays = Array.from(ex);
          }
          if (typeof imported.hoursStageDefaults === 'object' &&
              Object.keys(window.state.hoursStageDefaults || {}).length === 0) {
            window.state.hoursStageDefaults = imported.hoursStageDefaults;
          }
        }
        window.state.bulkSelectionMode = false;
        window.state.bulkSelectedTaskIds = [];
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state)); } catch (e) {}

        // 2) Push the whole state to the server atomically and WAIT for it.
        //    getState() first so expectedVersion matches the server's current
        //    version (the version guard is NOT bypassed by confirmDestructive).
        //    Retry a few times in case the version moves between read and write.
        const full = JSON.parse(JSON.stringify(window.state));
        let saved = false, lastErr = null;
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          try {
            await window.api.getState({ force: true }); // refresh expectedVersion
            await window.api.putState(full, { confirmDestructive: true });
            saved = true;
          } catch (err) {
            lastErr = err;
            await new Promise(r => setTimeout(r, 300));
          }
        }
        if (!saved) throw (lastErr || new Error('could not save to server'));

        // 3) Reset the sync baseline so the incremental diff sees no change and
        //    doesn't immediately fight the import we just pushed.
        window.lastSyncedState = JSON.parse(JSON.stringify(window.state));

        if (typeof window.closeImportConfirm === 'function') window.closeImportConfirm();
        alert('Import complete (' + mode + '). Saved to the server. Reloading…');
        window.location.reload();
      } catch (e) {
        console.error('Import apply failed:', e);
        alert('Import could NOT be saved to the server:\n' + (e && e.message ? e.message : e) +
              '\n\nNothing on the server was changed.');
        if (typeof window.closeImportConfirm === 'function') window.closeImportConfirm();
      }
    };
  }

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
  // Hide empty (0-task) stage tabs so a project -- especially one just created
  // from a template -- shows only the stages it actually uses, not all ~20
  // global stages. Done as a post-render DOM pass (external layer) so it
  // survives app.js regeneration. Only touches the stage grouping; never hides
  // the "All" tab or the currently-active tab. A stage tab's count reads
  // "<done>/<total>"; total === 0 means the stage has no tasks in this project.
  function hideEmptyStageTabs() {
    try {
      if (!window.state || window.state.grouping !== 'stage') return;
      document.querySelectorAll('.pill-tab').forEach(function (tab) {
        const oc = tab.getAttribute('onclick') || '';
        if (oc.indexOf("selectTab('all')") !== -1) return;   // keep the All tab
        if (tab.classList.contains('active')) return;         // keep the active tab
        const cnt = tab.querySelector('.count');
        if (!cnt) return;
        const total = parseInt((cnt.textContent.split('/')[1] || '').trim(), 10);
        if (total === 0) tab.style.display = 'none';
      });
    } catch (e) {}
  }
  function installStageTabFilter() {
    const orig = window.render;
    if (typeof orig !== 'function' || orig.__sbgStageTabHooked) return;
    const wrapped = function () {
      const r = orig.apply(this, arguments);
      hideEmptyStageTabs();
      return r;
    };
    wrapped.__sbgStageTabHooked = true;
    window.render = wrapped;
  }

  function boot() {
    installSaveHook();
    installImportOverride();
    installStageTabFilter();
    hideEmptyStageTabs();
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
