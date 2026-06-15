/* =============================================================================
 * theme-rh.js -- applies the "Robinhood-smooth" theme and its light/dark/classic
 * toggle. Device-local only (localStorage 'sbg_theme_rh'); never synced.
 *
 * Modes: 'light' (theme on, light) · 'dark' (theme on, dark) · 'off' (classic).
 * A single header button cycles light -> dark -> classic so the team can A/B
 * the new look against the original at any time.
 *
 * Also adds a one-shot count-up animation on the Today stat tiles when that
 * view is entered -- the small motion flourish that reads as "smooth".
 *
 * Loaded `defer` after app.js + router.js, so window.openHomeView exists.
 * ========================================================================== */
(function () {
  const KEY = 'sbg_theme_rh';
  const MODES = ['light', 'dark', 'off'];
  const ICON = { light: '☀', dark: '☾', off: '◐' };          // sun / moon / half
  const NEXT = { light: 'Switch to dark mode', dark: 'Switch to classic', off: 'Switch to new look (light)' };

  let btn = null;

  function current() {
    try { const v = localStorage.getItem(KEY); return MODES.indexOf(v) !== -1 ? v : 'light'; }
    catch (e) { return 'light'; }
  }

  function apply(mode) {
    const b = document.body;
    if (!b) return;
    const on = mode !== 'off';
    b.classList.toggle('theme-rh', on);
    b.classList.toggle('theme-dark', mode === 'dark');
    // theme-rh is a complete visual layer; suppress the older visual-polish
    // layer while it's active so the two don't fight, and restore it for the
    // classic ('off') look.
    b.classList.toggle('visual-polish', !on);
    updateToggle(mode);
  }

  function set(mode) {
    if (MODES.indexOf(mode) === -1) mode = 'light';
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    apply(mode);
  }

  function cycle() {
    set(MODES[(MODES.indexOf(current()) + 1) % MODES.length]);
  }

  function updateToggle(mode) {
    if (!btn) return;
    btn.textContent = ICON[mode] || ICON.light;
    btn.title = NEXT[mode] || 'Toggle theme';
    btn.setAttribute('aria-label', NEXT[mode] || 'Toggle theme');
  }

  function injectToggle() {
    if (document.getElementById('rhToggle')) return;
    const header = document.querySelector('header');
    if (!header) return;
    btn = document.createElement('button');
    btn.id = 'rhToggle';
    btn.className = 'rh-toggle';
    btn.type = 'button';
    btn.addEventListener('click', cycle);
    const chip = header.querySelector('.current-user-chip') || header.querySelector('#currentUserChip');
    if (chip && chip.parentNode) chip.parentNode.insertBefore(btn, chip);
    else header.appendChild(btn);
    updateToggle(current());
  }

  // ---- count-up on the Today stat tiles --------------------------------------
  function countUp() {
    if (current() === 'off') return;
    document.querySelectorAll('#homeView .hs-value').forEach(function (el) {
      if (el.dataset.rhAnimated === '1') return;
      const raw = (el.textContent || '').trim();
      const m = raw.match(/^(\d[\d,]*)(.*)$/);
      if (!m) return;
      const target = parseInt(m[1].replace(/,/g, ''), 10);
      if (!isFinite(target) || target <= 0) return;
      const suffix = m[2] || '';
      el.dataset.rhAnimated = '1';
      const dur = 520, t0 = performance.now();
      (function step(now) {
        const p = Math.min(1, (now - t0) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toLocaleString() + suffix;
        if (p < 1) requestAnimationFrame(step);
      })(t0);
    });
  }
  function resetCountUp() {
    document.querySelectorAll('#homeView .hs-value').forEach(function (el) { delete el.dataset.rhAnimated; });
  }
  function scheduleCountUp() {
    requestAnimationFrame(function () { requestAnimationFrame(countUp); });
  }

  function boot() {
    apply(current());
    injectToggle();
    // Re-run the count-up each time Today is entered.
    if (typeof window.openHomeView === 'function') {
      const orig = window.openHomeView;
      window.openHomeView = function () {
        const r = orig.apply(this, arguments);
        resetCountUp();
        scheduleCountUp();
        return r;
      };
    }
    scheduleCountUp();  // in case we're already on Today at boot
  }

  window.themeRh = { set: set, cycle: cycle, current: current };
  boot();
})();
