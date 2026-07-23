// Mirror the freshly built Next.js static export (apps/web/out) into the
// committed, server-served export (apps/api/public).
//
// The deploy build (scripts/build.mjs) intentionally does NOT run `next build`
// on the constrained Railway builder — it serves the export as committed bytes
// so the deploy can never OOM. This script keeps that committed copy honest:
// whoever rebuilds the web app (`npm run build:web`) refreshes apps/api/public
// in the same step, so the checked-in export never silently drifts from source.
//
// Runs as the last stage of `build:web`, after hoist + verify, so only a fully
// built and self-checked export is ever mirrored. No secrets are touched.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps', 'web', 'out');
const dest = join(root, 'apps', 'api', 'public');

if (!existsSync(join(src, 'index.html'))) {
  console.error(
    `[sync-public-export] no built export at ${src} — run \`npm run build:web\` first`
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[sync-public-export] mirrored ${src} -> ${dest}`);
