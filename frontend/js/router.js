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
        window.openStatusSnapshot();
      } else if (r.view === 'workload' && typeof window.openTeamWorkloadView === 'function') {
        window.openTeamWorkloadView();
      } else if (r.view === 'project' && r.projectId && projectExists(r.projectId)) {
        window.selectProject(r.projectId);
        if (r.mode && typeof window.setViewMode === 'function') window.setViewMode(r.mode);
      } else if (typeof window.openHomeView === 'function') {
        window.openHomeView();
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
      if (!_applying) syncHashFromState();
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

  // Re-apply the current URL (used by app.js after the async server load, when
  // a deep-linked project may not have been in the local cache on first paint).
  function reapply() {
    if (isOwnHash(location.hash)) applyRoute(location.hash);
    else if (typeof window.openHomeView === 'function') window.openHomeView();
  }

  window.router = { boot, reapply, applyRoute, syncHashFromState, parseHash, hashFromState, isDeepLink: function () {
    const r = parseHash(location.hash);
    return !!r && r.view !== 'today';
  } };

  // app.js (a deferred script) has already run its synchronous init by the time
  // this deferred script executes, so window.state and the view functions exist.
  boot();
})();
