/* =============================================================================
 * router.js -- lightweight hash router that turns each in-app view into a
 * real, shareable, bookmarkable URL with working browser Back/Forward.
 *
 * The app is a single page that swaps full-screen "views" by toggling state
 * flags (homeView / statusSnapshotView / teamWorkloadView) or, for a project,
 * activeProjectId + viewMode. None of that was reflected in the URL, so you
 * couldn't link to "the schedule" or press Back. This adds a thin layer that:
 *
 *   - reads the URL on load and opens the matching view (deep linking);
 *   - updates the URL whenever the user navigates (via the existing open /
 *     setViewMode functions, which we wrap -- app.js itself is untouched);
 *   - listens for hashchange so Back/Forward and pasted links navigate.
 *
 * Route grammar (all under the `#/` prefix so we never collide with the
 * notification links, which use the bare `#project=...&task=...` form and are
 * parsed from a data-attribute, not the URL):
 *
 *   #/today                       Today / home dashboard
 *   #/snapshot                    Status Snapshot (cross-project)
 *   #/workload                    Team Workload
 *   #/project/<id>                a project (defaults to the board)
 *   #/project/<id>/<mode>         mode = board | table | schedule | calendar | lookahead
 *
 * Loads AFTER app.js (so the global view functions and window.state exist).
 * =============================================================================
 */
(function () {
  const MODES = ['board', 'table', 'schedule', 'calendar', 'lookahead'];

  // True while we're applying a route, so the wrapped navigation functions
  // don't write the hash back (which would fight the URL we're reacting to).
  let _applying = false;
  // A project route we couldn't satisfy from cache yet (deep link to a project
  // the local workspace hasn't loaded). Resolved once server state arrives.
  let _pendingRoute = null;
  let _bootSyncDone = false;

  function norm(h) {
    return String(h || '').replace(/^#/, '').replace(/\/+$/, '') || '/';
  }

  // A hash is "ours" only if it uses the #/ prefix. Anything else (e.g. a
  // notification's #project=...&task=...) is left entirely alone.
  function isOwnHash(h) {
    return String(h || '').indexOf('#/') === 0;
  }

  function parseHash(h) {
    const raw = String(h || '');
    if (!isOwnHash(raw)) return null;
    const parts = raw.replace(/^#\//, '').split('/').filter(Boolean);
    if (parts.length === 0) return { view: 'today' };
    if (parts[0] === 'snapshot') return { view: 'snapshot' };
    if (parts[0] === 'workload') return { view: 'workload' };
    if (parts[0] === 'today') return { view: 'today' };
    if (parts[0] === 'project' && parts[1]) {
      const mode = MODES.indexOf(parts[2]) !== -1 ? parts[2] : 'board';
      return { view: 'project', projectId: decodeURIComponent(parts[1]), mode };
    }
    return { view: 'today' };
  }

  // The canonical URL for the CURRENT app state.
  function hashFromState() {
    const s = window.state || {};
    if (s.teamWorkloadView) return '#/workload';
    if (s.statusSnapshotView) return '#/snapshot';
    if (s.homeView) return '#/today';
    if (s.activeProjectId) {
      return '#/project/' + encodeURIComponent(s.activeProjectId) + '/' + (s.viewMode || 'board');
    }
    return '#/today';
  }

  function projectExists(id) {
    return !!(window.state && Array.isArray(window.state.projects) &&
              window.state.projects.some(p => p.id === id));
  }

  // Drive the app to match a route. Calls the same functions the UI buttons
  // call, so behavior is identical to clicking.
  function applyRoute(h) {
    const r = parseHash(h);
    if (!r) return;
    _applying = true;
    try {
      if (r.view === 'snapshot' && typeof window.openStatusSnapshot === 'function') {
        window.openStatusSnapshot(); clearPending();
      } else if (r.view === 'workload' && typeof window.openTeamWorkloadView === 'function') {
        window.openTeamWorkloadView(); clearPending();
      } else if (r.view === 'project' && r.projectId) {
        if (projectExists(r.projectId)) {
          window.selectProject(r.projectId);
          if (r.mode && typeof window.setViewMode === 'function') window.setViewMode(r.mode);
          clearPending();
        } else {
          // The project isn't in the local cache yet -- e.g. a link shared with
          // someone who hasn't loaded that project. Show a loader and resolve
          // once the workspace finishes loading, instead of flashing Today.
          _pendingRoute = r;
          showRouteLoading();
          ensureStateLoad();
        }
      } else if (typeof window.openHomeView === 'function') {
        window.openHomeView(); clearPending();
      }
    } finally {
      _applying = false;
    }
  }

  // Push the current state's URL into the address bar (only if it differs).
  function syncHashFromState() {
    const want = hashFromState();
    if (norm(location.hash) !== norm(want)) {
      location.hash = want;   // fires hashchange; handler no-ops since it matches state
    }
  }

  // Wrap the existing navigation entry points so any UI navigation updates the
  // URL. We deliberately don't touch app.js -- this keeps routing additive and
  // easy to remove.
  function wrap(name) {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      const out = orig.apply(this, arguments);
      if (!_applying) {
        clearPending();   // a real user navigation supersedes a pending deep-link load
        syncHashFromState();
      }
      return out;
    };
  }
  ['openHomeView', 'openStatusSnapshot', 'openTeamWorkloadView', 'selectProject', 'setViewMode'].forEach(wrap);

  // Back/Forward, pasted links, manual edits.
  window.addEventListener('hashchange', function () {
    if (_applying) return;
    if (!isOwnHash(location.hash)) return;                 // not our format -> ignore
    if (norm(location.hash) === norm(hashFromState())) return;  // already in sync
    applyRoute(location.hash);
  });

  // Apply the URL on load if it's a deep link; otherwise reflect the default
  // view (Today) into the address bar so the URL is always meaningful.
  function boot() {
    if (isOwnHash(location.hash)) applyRoute(location.hash);
    else syncHashFromState();
  }

  // --- pending deep-link resolution -----------------------------------------

  function clearPending() {
    _pendingRoute = null;
    hideRouteLoading();
  }

  // Make sure the workspace gets loaded so a pending project can resolve. At
  // boot, app.js already kicks a sync and will call afterStateLoad() for us, so
  // we only trigger our own fetch for a hashchange that happens AFTER boot.
  function ensureStateLoad() {
    if (!_pendingRoute) return;
    if (!_bootSyncDone) return;   // boot sync in flight -> afterStateLoad resolves us
    if (typeof window.syncStateFromServer === 'function') {
      window.syncStateFromServer().then(resolvePending).catch(resolvePending);
    } else {
      resolvePending();
    }
  }

  // Called once the workspace finishes loading. Definitive: navigates to the
  // pending project if it now exists, otherwise reports it missing -- never
  // re-pends, so there's no loop if the project truly isn't there.
  function resolvePending() {
    if (!_pendingRoute) return;
    const want = _pendingRoute;
    // If the user navigated elsewhere while we were loading, abandon quietly.
    const cur = parseHash(location.hash);
    if (!cur || cur.view !== 'project' || cur.projectId !== want.projectId) {
      clearPending();
      return;
    }
    if (projectExists(want.projectId)) {
      _pendingRoute = null;
      hideRouteLoading();
      _applying = true;
      try {
        window.selectProject(want.projectId);
        if (want.mode && typeof window.setViewMode === 'function') window.setViewMode(want.mode);
      } finally {
        _applying = false;
      }
    } else {
      clearPending();
      routeNotFound();
    }
  }

  // app.js calls this after its boot-time server sync (regardless of whether
  // state changed), so a deep-linked project that wasn't cached on first paint
  // resolves as soon as data lands.
  function afterStateLoad() {
    _bootSyncDone = true;
    resolvePending();
  }

  function routeNotFound() {
    _applying = true;
    try { if (typeof window.openHomeView === 'function') window.openHomeView(); }
    finally { _applying = false; }
    if (norm(location.hash) !== norm('#/today')) location.hash = '#/today';
    showRouteToast('That project link could not be opened — it may have been removed or you may not have access.');
  }

  // --- tiny loader + toast UI (self-contained) ------------------------------

  function injectRouteStyles() {
    if (document.getElementById('sbg-route-style')) return;
    const s = document.createElement('style');
    s.id = 'sbg-route-style';
    s.textContent = [
      '#route-loading{position:fixed;inset:0;z-index:99998;display:none;align-items:center;',
      'justify-content:center;background:rgba(255,255,255,0.92);font-family:\'Inter\',system-ui,sans-serif;}',
      '#route-loading .rl-card{text-align:center;color:#0a2540;}',
      '#route-loading .rl-spinner{width:38px;height:38px;margin:0 auto 14px;border:3px solid #dbe2ea;',
      'border-top-color:#c8322b;border-radius:50%;animation:rl-spin .8s linear infinite;}',
      '@keyframes rl-spin{to{transform:rotate(360deg);}}',
      '#route-loading .rl-text{font-size:14px;font-weight:600;letter-spacing:.02em;}',
      '#route-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(8px);',
      'z-index:99999;background:#0a2540;color:#fff;padding:11px 16px;border-radius:6px;',
      'font-family:\'Inter\',system-ui,sans-serif;font-size:13px;max-width:360px;line-height:1.35;',
      'box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;}',
      '#route-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
    ].join('');
    document.head.appendChild(s);
  }

  function showRouteLoading() {
    injectRouteStyles();
    let el = document.getElementById('route-loading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'route-loading';
      el.innerHTML = '<div class="rl-card"><div class="rl-spinner"></div><div class="rl-text">Loading project…</div></div>';
      document.body.appendChild(el);
    }
    el.style.display = 'flex';
  }

  function hideRouteLoading() {
    const el = document.getElementById('route-loading');
    if (el) el.style.display = 'none';
  }

  let _toastTimer = null;
  function showRouteToast(msg) {
    injectRouteStyles();
    let t = document.getElementById('route-toast');
    if (!t) { t = document.createElement('div'); t.id = 'route-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.classList.remove('show'); }, 4000);
  }

  window.router = { boot, afterStateLoad, applyRoute, syncHashFromState, parseHash, hashFromState, isDeepLink: function () {
    const r = parseHash(location.hash);
    return !!r && r.view !== 'today';
  } };

  // app.js (a deferred script) has already run its synchronous init by the time
  // this deferred script executes, so window.state and the view functions exist.
  boot();
})();
