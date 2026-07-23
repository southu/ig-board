// Post-build step for the web static export.
//
// Next injects its own preload/bundle <script> tags at the top of <head>, so the
// inline theme-init script authored in app/layout.js ends up *after* them in
// source order. It still executes first (it's synchronous; the bundles are
// async), but to make the "inline head script before app bundles" guarantee
// hold positionally too, this moves the marked script to be the first child of
// <head> in every exported HTML file. Idempotent.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'apps', 'web', 'out');

// Match the inline theme-init script emitted by app/layout.js (tagged with the
// data-theme-init attribute so we never move an unrelated script).
const THEME_SCRIPT_RE = /<script data-theme-init="">[\s\S]*?<\/script>/;

function htmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) found.push(...htmlFiles(full));
    else if (entry.endsWith('.html')) found.push(full);
  }
  return found;
}

let moved = 0;
for (const file of htmlFiles(outDir)) {
  const html = readFileSync(file, 'utf8');
  const match = html.match(THEME_SCRIPT_RE);
  if (!match) continue;
  const script = match[0];
  const withoutScript = html.replace(script, '');
  // Insert immediately after the opening <head ...> tag.
  const hoisted = withoutScript.replace(/(<head[^>]*>)/, `$1${script}`);
  if (hoisted !== html) {
    writeFileSync(file, hoisted);
    moved += 1;
  }
}

console.log(`[hoist-theme-head] hoisted theme-init in ${moved} file(s)`);
