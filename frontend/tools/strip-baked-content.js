#!/usr/bin/env node
/* =============================================================================
 * strip-baked-content.js -- normalize the static index.html shell.
 *
 * index.html was extracted from the original single-file app WITH a live
 * workspace baked in: 352 base64 project thumbnails/avatars (~3.3 MB) plus
 * ~290 demo task cards and ~280 schedule rows of real data, frozen into the
 * markup. The app regenerates ALL of it from state on boot (render()), so the
 * baked-in copy is pure download/parse weight -- and it leaks real project,
 * client, and people names into a publicly-served file.
 *
 * This transform:
 *   1. Replaces every base64 image payload with a 1x1 transparent placeholder
 *      (the app overwrites each <img src> from state at render time).
 *   2. Empties the inner HTML of containers that render() fully rebuilds, so
 *      the shipped shell is structural-only.
 *
 * It is idempotent -- safe to re-run after a future re-export from the app.
 *
 * Usage:  node tools/strip-baked-content.js [path/to/index.html]
 * =============================================================================
 */
const fs = require('fs');
const path = require('path');

const FILE = process.argv[2] || path.resolve(__dirname, '..', 'index.html');
// 1x1 transparent GIF -- smallest broadly-supported placeholder (~43 bytes).
const PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Containers render() rebuilds wholesale (verified: each does `el.innerHTML =`).
// We empty their inner content but keep the structural open/close tags.
const EMPTY_BY_ID = ['projectList', 'scheduleChart', 'allStagesView'];
const EMPTY_BY_ATTR = ['data-list'];   // the 5 board status columns

// Find the matching </div> for a <div ...> whose open tag starts at `openIdx`.
// Counts only div tags (the file has no `>` inside attributes -- verified), so
// nested spans/imgs/inputs don't affect depth. Returns the index just before
// the matching </div>, or -1.
function findDivInnerEnd(html, openIdx) {
  const openEnd = html.indexOf('>', openIdx);
  if (openEnd === -1) return -1;
  const re = /<\/?div\b[^>]*>/g;
  re.lastIndex = openEnd + 1;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[0].slice(0, 2) === '</') {
      if (--depth === 0) return m.index;
    } else {
      depth++;
    }
  }
  return -1;
}

function emptyContainer(html, openRegex) {
  const m = openRegex.exec(html);
  if (!m) return { html, changed: false };
  const openIdx = m.index;
  const openEnd = html.indexOf('>', openIdx);
  const innerEnd = findDivInnerEnd(html, openIdx);
  if (innerEnd === -1 || innerEnd <= openEnd) return { html, changed: false };
  const inner = html.slice(openEnd + 1, innerEnd);
  if (inner.trim() === '') return { html, changed: false };
  return { html: html.slice(0, openEnd + 1) + html.slice(innerEnd), changed: true };
}

function main() {
  let html = fs.readFileSync(FILE, 'utf8');
  const before = Buffer.byteLength(html);

  // 1. Base64 -> placeholder
  let imgCount = 0;
  html = html.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+?(?=["')])/gi, () => {
    imgCount++;
    return PLACEHOLDER;
  });

  // 2. Empty render-rebuilt containers
  let emptied = 0;
  for (const id of EMPTY_BY_ID) {
    const r = emptyContainer(html, new RegExp(`<div[^>]*\\bid="${id}"[^>]*>`));
    html = r.html; if (r.changed) emptied++;
  }
  for (const attr of EMPTY_BY_ATTR) {
    // There can be several (e.g. 5 board columns); empty each until none remain.
    let guard = 0;
    while (guard++ < 50) {
      const r = emptyContainer(html, new RegExp(`<div[^>]*\\b${attr}="[^"]*"[^>]*>`));
      if (!r.changed) break;
      html = r.html; emptied++;
    }
  }

  fs.writeFileSync(FILE, html);
  const after = Buffer.byteLength(html);
  console.log(`[strip] ${path.basename(FILE)}: ${(before / 1048576).toFixed(2)} MB -> ${(after / 1048576).toFixed(2)} MB`);
  console.log(`[strip] base64 images placeholdered: ${imgCount}; containers emptied: ${emptied}`);
}

main();
