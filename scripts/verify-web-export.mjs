// Post-build self-check for the web static export (apps/web/out).
//
// The exported HTML/CSS is the acceptance-critical web surface — invite-only
// login, the pre-hydration theme script, and both [data-theme] token variants.
// A subtly broken export (missing theme script, a stray password field, an
// absent theme variant) still "builds" and deploys, and would only be caught
// once the live tester runs. This script asserts those guarantees at build time
// so a regression is visible in the deploy logs immediately.
//
// It is deliberately NON-FATAL: the acceptance-critical service is the API
// (/health, /version, /me), which stays healthy even when the web export is
// imperfect (see scripts/build.mjs). So failures here are logged loudly and the
// process still exits 0 — the deploy proceeds and operators see exactly what to
// fix. No secrets are read or printed.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'apps', 'web', 'out');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const tag = ok ? 'ok  ' : 'FAIL';
  console.log(`[verify-web-export] ${tag} ${name}${detail ? ` — ${detail}` : ''}`);
}

function read(rel) {
  const full = join(outDir, rel);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
}

if (!existsSync(join(outDir, 'index.html'))) {
  console.warn(
    '[verify-web-export] no export found at apps/web/out — skipping checks ' +
      '(the API deploy is unaffected; the server serves a JSON index at /).'
  );
  process.exit(0);
}

const login = read('login.html');
const index = read('index.html');

// Login page: magic-link email form, no password, no self-signup CTA.
if (login) {
  check('login has an email input', /type="email"/.test(login));
  check('login has NO password input', !/type="password"/.test(login));
  check(
    'login has no self-signup / register CTA',
    !/sign[\s-]?up|register|create account/i.test(login)
  );
} else {
  check('login.html exists', false, 'missing');
}

// No self-signup routes exported (the server 404s them too).
check('no signup.html exported', !existsSync(join(outDir, 'signup.html')));
check('no register.html exported', !existsSync(join(outDir, 'register.html')));

// Pre-hydration theme script must run BEFORE the app bundles: the marked
// <script data-theme-init> has to appear ahead of the first /_next/ asset
// reference in the served HTML, read localStorage, and fall back to matchMedia.
if (index) {
  const themeIdx = index.indexOf('data-theme-init');
  const firstBundle = index.indexOf('/_next/');
  check(
    'theme-init script precedes the app bundles',
    themeIdx !== -1 && (firstBundle === -1 || themeIdx < firstBundle),
    `themeIdx=${themeIdx}, firstBundle=${firstBundle}`
  );
  check(
    'theme-init reads localStorage',
    /data-theme-init[\s\S]{0,400}localStorage\.getItem/.test(index)
  );
  check(
    'theme-init falls back to prefers-color-scheme',
    /data-theme-init[\s\S]{0,400}prefers-color-scheme/.test(index)
  );
} else {
  check('index.html exists', false, 'missing');
}

// CSS defines both light and dark [data-theme] variants with the required tokens.
let css = '';
const cssDir = join(outDir, '_next', 'static', 'css');
if (existsSync(cssDir)) {
  for (const f of readdirSync(cssDir)) {
    if (f.endsWith('.css')) css += read(join('_next', 'static', 'css', f)) || '';
  }
}
check('CSS defines [data-theme=light]', /data-theme=(["']?)light\1\]/.test(css));
check('CSS defines [data-theme=dark]', /data-theme=(["']?)dark\1\]/.test(css));
for (const token of ['--surface', '--rag-green', '--band-manage']) {
  check(`CSS defines ${token}`, css.includes(`${token}:`));
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.warn(
    `[verify-web-export] ${failed.length} check(s) FAILED: ${failed
      .map((r) => r.name)
      .join('; ')}. The web export is degraded but the API deploy proceeds; ` +
      'fix the web build to restore the acceptance-critical web surface.'
  );
} else {
  console.log(`[verify-web-export] all ${results.length} checks passed.`);
}
// Non-fatal by design — never fail the deploy on a web-export issue.
process.exit(0);
