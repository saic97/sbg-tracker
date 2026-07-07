#!/usr/bin/env node
/* =============================================================================
 * build-from-monolith.js -- regenerate the split + backend production frontend
 * from the single-file source of truth.
 *
 * The team develops in the self-contained single-file app (one big HTML with
 * inline <style> + <script>). Production is the split app with a real backend
 * (login, multi-user sync, shareable URLs). This pipeline bridges them so new
 * features added in the single file flow to production with ONE command --
 * no hand-porting.
 *
 * What it does:
 *   1. Extracts inline <style> -> css/styles.css and inline <script> -> js/app.js
 *   2. Patches `let state` -> `var state` (makes window.state visible to the
 *      external integration layer -- load-bearing)
 *   3. Strips baked-in base64 images to a 1px placeholder
 *   4. Rebuilds index.html: the single file's markup, minus the inline
 *      script/style, PLUS the external architecture files (api, auth, realtime,
 *      router, sync-integration) and the api-base/api-enabled meta tags
 *
 * The architecture itself lives in the external files and hooks the app's
 * globals WITHOUT editing app.js (see sync-integration.js / router.js). So a
 * new single-file version drops straight through this pipeline.
 *
 * Usage:  node tools/build-from-monolith.js <path-to-single-file.html>
 * Output: overwrites frontend/index.html, frontend/js/app.js, frontend/css/styles.css
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.error('Usage: node tools/build-from-monolith.js <single-file.html>');
  process.exit(1);
}
const FRONTEND = path.resolve(__dirname, '..');

// External architecture + feature files, in load order. app.js (the
// regenerated single file) MUST come before router.js + sync-integration.js,
// which wrap its globals at load time. The feature-UI files inject their UI on
// DOMContentLoaded and defensively check for elements, so they coexist with the
// single file's markup. visual-polish.js / theme-rh.* are intentionally NOT
// included -- the single file's own CSS is the source of truth for appearance.
const EXTERNAL_SCRIPTS = [
  'js/auth-ui.js',       // login overlay + window.auth
  'js/api.js',           // REST client (window.api)
  'js/realtime.js',      // Socket.IO multi-user (window.realtime)
  'js/scope-extract.js', // AI scope extraction (backend)
  'js/attachments.js',   // server-backed file attachments
  'js/admin-panel.js',   // user management
  'js/notifications.js', // per-user notification inbox
  'js/sub-bids.js',      // sub-bid email intake
  'js/user-menu.js',     // avatar + sign-out
  'js/app.js',           // the regenerated single file
  'js/router.js',        // shareable hash URLs
  'js/sync-integration.js', // local-first incremental backend sync
];

const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

let html = fs.readFileSync(SRC, 'utf8');

// 1. Pull out inline <style> blocks -> css.
let css = '';
html = html.replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (_m, body) => { css += body + '\n'; return ''; });

// 2. Pull out inline <script> (no src attr) -> js.
let js = '';
html = html.replace(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi, (_m, body) => { js += body + '\n'; return ''; });

// 3. `let state` -> `var state` (the single load-bearing patch).
const before = js;
js = js.replace(/\blet\s+state\s*=/, 'var state =');
const statePatched = js !== before;

// 3b. Known source-file bug fixups. Each is idempotent: once the team fixes
// their single file, the pattern stops matching and the fixup no-ops.
//   - renderAvatarHtml: v99 guards it with a bare `renderAvatarHtml ?` -- a
//     bare reference to an UNDECLARED identifier throws ReferenceError before
//     the guard can help (crashed the Status Snapshot view). Rewrite to the
//     typeof guard the code intended, so the inline fallback avatar is used.
const FIXUPS = [
  {
    name: 'renderAvatarHtml bare guard -> typeof guard',
    find: /\brenderAvatarHtml\s*\?\s*renderAvatarHtml\(/g,
    replace: "(typeof renderAvatarHtml === 'function') ? renderAvatarHtml(",
  },
];
for (const f of FIXUPS) {
  const n = (js.match(f.find) || []).length;
  if (n) { js = js.replace(f.find, f.replace); console.log(`[build] fixup applied (${n}x): ${f.name}`); }
}

// 4. Head: drop any existing api meta, then inject our meta + the stylesheet link.
html = html.replace(/<meta name="api-base"[^>]*>\s*/gi, '')
           .replace(/<meta name="api-enabled"[^>]*>\s*/gi, '');
const headInject =
  '<meta name="api-base" content="">\n' +
  '<meta name="api-enabled" content="true">\n' +
  '<link rel="stylesheet" href="css/styles.css">\n';
html = html.replace(/<\/head>/i, headInject + '</head>');

// 5. Body: inject the external architecture scripts before </body>.
const scriptTags = EXTERNAL_SCRIPTS.map(s => `<script src="${s}" defer></script>`).join('\n') + '\n';
html = html.replace(/<\/body>/i, scriptTags + '</body>');

// 6. Strip baked-in base64 images (download/parse weight; regenerated at render).
let imgCount = 0;
html = html.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+?(?=["')])/gi, () => { imgCount++; return PLACEHOLDER; });

// Write outputs.
fs.writeFileSync(path.join(FRONTEND, 'index.html'), html);
fs.writeFileSync(path.join(FRONTEND, 'css', 'styles.css'), css);
fs.writeFileSync(path.join(FRONTEND, 'js', 'app.js'), js);

const kb = n => Math.round(n / 1024);
console.log('[build] source:', path.basename(SRC));
console.log('[build] index.html:', kb(Buffer.byteLength(html)), 'KB  (base64 imgs stripped:', imgCount + ')');
console.log('[build] css/styles.css:', kb(Buffer.byteLength(css)), 'KB');
console.log('[build] js/app.js:', kb(Buffer.byteLength(js)), 'KB  (let state -> var state:', statePatched + ')');
console.log('[build] external scripts wired:', EXTERNAL_SCRIPTS.length);
if (!statePatched) console.warn('[build] WARNING: did not find `let state =` to patch -- check window.state exposure.');
