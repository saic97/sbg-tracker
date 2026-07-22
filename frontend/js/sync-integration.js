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
    // The shared activity feed (bell dropdown). Each entry is authored on the
    // ACTOR's tab by _emitNotification; syncing the array (capped at 200 by the
    // app) is what lets OTHER computers see it -- and toast it (see
    // installNotificationRelay). notificationsLastSeenAt deliberately NOT here:
    // it's each user's own unread pointer.
    notifications: ['notifications'],
    // v140 deletion tombstones ({tasks:[],projects:[]}, boot-pruned by the
    // app). Created only on the DELETER's tab; syncing them means every
    // computer's merge-import honors deletions instead of resurrecting
    // deleted work from an old backup.
    tombstones: ['tombstones'],
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

    // Guarded write (see api.cacheState): quota-safe AND refuses to persist an
    // empty workspace beside a version stamp (the 304 "empty forever" trap).
    if (window.api && typeof window.api.cacheState === 'function') {
      window.api.cacheState(state);
    } else {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
      catch (e) {
        try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem('sbg_state_version'); } catch (e2) {}
      }
    }
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
  window.dedupRecurringDuplicates = function () { return dedupRecurringDuplicates(); };

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
  // Wrap applyImport: DELEGATE the state mutation to the app's own
  // implementation (whose merge logic keeps evolving -- v134 fixed the
  // taskTemplates key, v136 added classification/notification/pref merging;
  // reimplementing it here drifted), but swallow the timers it schedules
  // (the ~250ms location.reload() race + the saveState debounce), then push
  // the result ATOMICALLY via PUT /api/state (confirmDestructive), WAIT for
  // the server to confirm, reset the sync baseline, and only THEN reload.
  function installImportOverride() {
    if (!window.api || !window.api.enabled) return;
    const appApplyImport = window.applyImport;
    if (typeof appApplyImport !== 'function' || appApplyImport.__sbgImportWrapped) return;

    const wrapped = async function (mode) {
      // Fingerprint so a cancelled confirm / failed parse (which the app
      // handles internally) doesn't trigger a pointless server push.
      const fingerprint = function () {
        try { return (window.state.projects || []).length + ':' + JSON.stringify(window.state).length; }
        catch (e) { return String(Math.random()); }
      };
      const before = fingerprint();

      // Run the app's own import synchronously, capturing every timer it
      // schedules: its reload would race the async push, and the saveState
      // debounce would fight the atomic PUT below.
      const origSetTimeout = window.setTimeout;
      window.setTimeout = function () { return 0; };
      try {
        appApplyImport(mode);
      } finally {
        window.setTimeout = origSetTimeout;
      }

      if (fingerprint() === before) return;   // user cancelled / import no-op

      try {
        window.state.bulkSelectionMode = false;
        window.state.bulkSelectedTaskIds = [];
        if (window.api && typeof window.api.cacheState === 'function') {
          window.api.cacheState(window.state);
        } else {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(window.state)); }
          catch (e) {
            try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem('sbg_state_version'); } catch (e2) {}
          }
        }

        // Push the whole state and WAIT. getState() first so expectedVersion
        // matches the server (the version guard is NOT bypassed by
        // confirmDestructive); retry in case the version moves between calls.
        const full = JSON.parse(JSON.stringify(window.state));
        let saved = false, lastErr = null;
        for (let attempt = 0; attempt < 4 && !saved; attempt++) {
          try {
            await window.api.getState({ force: true });
            await window.api.putState(full, { confirmDestructive: true });
            saved = true;
          } catch (err) {
            lastErr = err;
            await new Promise(r => setTimeout(r, 300));
          }
        }
        if (!saved) throw (lastErr || new Error('could not save to server'));

        // Reset the baseline so the incremental diff doesn't fight the push.
        window.lastSyncedState = JSON.parse(JSON.stringify(window.state));
        window.location.reload();
      } catch (e) {
        console.error('Import backend push failed:', e);
        alert('Import could NOT be saved to the server:\n' + (e && e.message ? e.message : e) +
              '\n\nThe server copy is unchanged. Fix the connection and try the import again.');
      }
    };
    wrapped.__sbgImportWrapped = true;
    window.applyImport = wrapped;
  }

  // ---- cross-computer notification toasts -----------------------------------
  // The app's _emitNotification runs on the ACTOR's tab only: it appends to
  // state.notifications and toasts locally. Syncing the array (settings group
  // 'notifications' above) delivers the entries to everyone else's state via
  // the realtime merge -- but nothing would POP for them. This relay watches
  // for entries this tab didn't author and runs them through the app's own
  // _spawnToast, so the app's rules (Just Mine / Team-wide scope, silence
  // toggle, Manager Mode) decide what actually pops.
  var _notifSeen = null;   // Set of notification ids this tab has processed
  function _seedNotifSeen() {
    _notifSeen = new Set();
    ((window.state && window.state.notifications) || []).forEach(function (n) {
      if (n && n.id) _notifSeen.add(n.id);
    });
  }
  function relayFreshNotifications() {
    if (!window.state || !Array.isArray(window.state.notifications)) return;
    if (_notifSeen === null) { _seedNotifSeen(); return; }   // first pass: history, don't toast
    var fresh = [];
    for (var i = 0; i < window.state.notifications.length; i++) {
      var n = window.state.notifications[i];
      if (!n || !n.id || _notifSeen.has(n.id)) continue;
      _notifSeen.add(n.id);
      fresh.push(n);
    }
    if (!fresh.length) return;
    // Keep the seen-set bounded (the feed itself is capped at 200 by the app).
    if (_notifSeen.size > 600) _seedNotifSeen();
    if (typeof window._spawnToast !== 'function') return;
    // Newest-first array; toast oldest-first so stacking reads naturally.
    for (var k = fresh.length - 1; k >= 0; k--) {
      try { window._spawnToast(fresh[k]); } catch (e) {}
    }
    if (typeof window._refreshNotificationBell === 'function') {
      try { window._refreshNotificationBell(); } catch (e) {}
    }
  }
  function installNotificationRelay() {
    // (a) register self-authored entries as seen BEFORE any render pass, so
    // this tab never re-toasts what the app already toasted locally.
    var origEmit = window._emitNotification;
    if (typeof origEmit === 'function' && !origEmit.__sbgNotifHooked) {
      var wrappedEmit = function () {
        var r = origEmit.apply(this, arguments);
        if (_notifSeen === null) _seedNotifSeen();
        else {
          var head = (window.state.notifications || [])[0];
          if (head && head.id) _notifSeen.add(head.id);
        }
        return r;
      };
      wrappedEmit.__sbgNotifHooked = true;
      window._emitNotification = wrappedEmit;
    }
    // (b) after every render (realtime merges always end in one), toast any
    // entry that arrived from another computer.
    var origRender = window.render;
    if (typeof origRender === 'function' && !origRender.__sbgNotifHooked) {
      var wrappedRender = function () {
        var r = origRender.apply(this, arguments);
        try { relayFreshNotifications(); } catch (e) {}
        try { throttledRecurringSweep(); } catch (e) {}
        return r;
      };
      wrappedRender.__sbgNotifHooked = true;
      window.render = wrappedRender;
    }
  }

  // ---- recurring-duplicate guard ---------------------------------------------
  // V139's spawn-recurrence-on-edit creates a brand-NEW series each time a
  // recurring task's recurrence is re-saved, instead of replacing the old one.
  // Every series then generates its own instances, so the same task piles up
  // N times per occurrence day (observed live: 295 groups / 849 extra tasks).
  // Until the monolith fixes that, this boot-time pass deletes same-day copies:
  // recurring instances only (seriesId + dueDate set), same project + same
  // normalized title + same due date; keeps the most-progressed copy
  // (done > in-progress > rest), tie-broken toward the OLDEST series (uids
  // sort chronologically). Deletions go through the app's own tombstone
  // recorder so V140 merge-imports keep them dead everywhere.
  function dedupRecurringDuplicates() {
    const st = window.state;
    if (!st || !Array.isArray(st.projects)) return 0;
    const rank = function (s) { return s === 'done' ? 3 : s === 'in-progress' ? 2 : 1; };

    // Occurrence dates the user deliberately deleted: tombstones that carry a
    // dueDate (stamped by installTombstoneDateStamp below). The app's rolling
    // 60-day generator (refreshAllSeriesInstances / ensureSeriesInstances-
    // Generated, runs on EVERY page load) regenerates deleted future
    // occurrences with FRESH ids -- id-based tombstones never match, so
    // deleted recurring tasks resurrected on refresh. Blocking by
    // seriesId+dueDate kills the respawn no matter what id it got. Completed
    // tasks are always spared.
    const blocked = new Set();
    const tombs = (st.tombstones && st.tombstones.tasks) || [];
    for (const ts of tombs) {
      if (ts && ts.seriesId && ts.dueDate) blocked.add(ts.seriesId + '|' + ts.dueDate);
    }

    let removed = 0;
    for (const p of st.projects) {
      if (!Array.isArray(p.tasks) || !p.tasks.length) continue;
      const doomed = new Set();

      // Pass 1: respawn blocker (tombstoned series+date, non-done only)
      if (blocked.size) {
        for (const t of p.tasks) {
          if (!t || !t.seriesId || !t.dueDate || t.status === 'done') continue;
          if (blocked.has(t.seriesId + '|' + t.dueDate)) doomed.add(t.id);
        }
      }

      // Pass 2: same-day duplicate collapse (recurring instances only)
      if (p.tasks.length > 1) {
        const groups = {};
        for (const t of p.tasks) {
          if (!t || !t.seriesId || !t.dueDate || doomed.has(t.id)) continue;
          const key = (t.title || '').trim().toLowerCase() + '|' + t.dueDate;
          (groups[key] = groups[key] || []).push(t);
        }
        for (const key in groups) {
          const g = groups[key];
          if (g.length < 2) continue;
          g.sort(function (a, b) {
            return (rank(b.status) - rank(a.status)) ||
                   String(a.seriesId).localeCompare(String(b.seriesId)) ||
                   String(a.id).localeCompare(String(b.id));
          });
          for (let i = 1; i < g.length; i++) doomed.add(g[i].id);
        }
      }

      if (!doomed.size) continue;
      const goners = p.tasks.filter(function (t) { return doomed.has(t.id); });
      p.tasks = p.tasks.filter(function (t) { return !doomed.has(t.id); });
      if (typeof window._recordTaskTombstonesBulk === 'function') {
        try { window._recordTaskTombstonesBulk(p, goners); } catch (e) {}
      }
      removed += goners.length;
    }
    return removed;
  }

  // Stamp dueDate onto every task tombstone the app records, so the respawn
  // blocker above can match regenerated copies (which carry new ids). The
  // app's own tombstone shape is otherwise untouched.
  function installTombstoneDateStamp() {
    const orig = window._recordTaskTombstone;
    if (typeof orig !== 'function' || orig.__sbgDateStamped) return;
    const wrapped = function (project, task) {
      const r = orig.apply(this, arguments);
      try {
        if (task && task.id && task.dueDate && window.state && window.state.tombstones) {
          const list = window.state.tombstones.tasks || [];
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i] && list[i].id === task.id) { list[i].dueDate = task.dueDate; break; }
          }
        }
      } catch (e) {}
      return r;
    };
    wrapped.__sbgDateStamped = true;
    window._recordTaskTombstone = wrapped;
  }

  // When the user deletes "this and future" or the "entire series", the
  // SERIES must stop generating -- otherwise the rolling 60-day generator
  // invents occurrence dates beyond the ones that existed (and were
  // tombstoned) at delete time. Cap every surviving member's
  // recurrence.endDate so computeNextRecurrenceDate returns null past the
  // cut; the app already honors endDate ("recurrence series has ended").
  // 'this-only' deletes leave the series alive (date-block handles those).
  function installSeriesDeleteStop() {
    const orig = window._applySeriesDelete;
    if (typeof orig !== 'function' || orig.__sbgSeriesStop) return;
    const dayBefore = function (iso) {
      try {
        const d = new Date(iso + 'T12:00:00');
        d.setDate(d.getDate() - 1);
        return d.toISOString().slice(0, 10);
      } catch (e) { return iso; }
    };
    const wrapped = function (project, existing, scope) {
      const n = orig.apply(this, arguments);
      try {
        if (n > 0 && project && existing && (scope === 'this-and-future' || scope === 'entire-series')) {
          const sid = existing.seriesId || existing.id;
          const cap = (scope === 'entire-series' || !existing.dueDate)
            ? dayBefore(new Date().toISOString().slice(0, 10))
            : dayBefore(existing.dueDate);
          for (const t of (project.tasks || [])) {
            if (!t || t.seriesId !== sid || !t.recurrence) continue;
            if (!t.recurrence.endDate || t.recurrence.endDate > cap) t.recurrence.endDate = cap;
          }
        }
      } catch (e) {}
      return n;
    };
    wrapped.__sbgSeriesStop = true;
    window._applySeriesDelete = wrapped;
  }

  // Mid-session sweep: the generator also tops up when a series member is
  // EDITED, which can resurrect deleted occurrences long after boot. Run the
  // guard (throttled) after renders; it converges to zero removals.
  let _lastSweep = 0;
  function throttledRecurringSweep() {
    const now = Date.now();
    if (now - _lastSweep < 5000) return;
    _lastSweep = now;
    try {
      const n = dedupRecurringDuplicates();
      if (n > 0) {
        console.log('[sync] recurring guard removed ' + n + ' resurrected/duplicate task(s)');
        if (typeof window.saveState === 'function') window.saveState();
        // Deferred so we never recurse into the render wrapper we're called
        // from; the 5s throttle makes the follow-up pass a no-op.
        setTimeout(function () {
          try { if (typeof window.render === 'function') window.render(); } catch (e) {}
        }, 50);
      }
    } catch (e) {}
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
  function boot() {
    installSaveHook();
    installImportOverride();
    installNotificationRelay();
    installTombstoneDateStamp();
    installSeriesDeleteStop();
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
      // Recurring-duplicate guard: runs once the server copy IS the sync
      // baseline, so the removals diff-sync as ordinary deletions.
      try {
        const n = dedupRecurringDuplicates();
        // Empty-leads normalizer: newer saves/clones write `leads: []`, which
        // several aggregators treat as authoritative ("this task has no
        // people") instead of falling back to task.assignee -- the task then
        // vanishes from workload cards, insights, etc. An empty array is
        // semantically identical to an absent field everywhere the fallback
        // exists, so drop the key and every consumer heals at once.
        let normalized = 0;
        for (const p of (window.state.projects || [])) {
          for (const t of (p.tasks || [])) {
            if (t && Array.isArray(t.leads) && t.leads.length === 0) { delete t.leads; normalized++; }
          }
        }
        if (n > 0 || normalized > 0) {
          if (n > 0) console.log('[sync] recurring-duplicate guard removed ' + n + ' same-day duplicate task(s)');
          if (normalized > 0) console.log('[sync] normalized ' + normalized + ' empty leads[] arrays (workload attribution fix)');
          if (typeof window.saveState === 'function') window.saveState();
          if (typeof render === 'function') render();
        }
      } catch (e) { console.warn('[sync] boot guard failed:', e && e.message); }
    });
  }

  boot();
})();
