// Deploy build orchestrator for the ig-board Railway service.
//
// The Railway `buildCommand` runs this. It does two things, in order:
//   1. Build the Next.js static web export (apps/web/out) and hoist the theme
//      head script into each page.
//   2. Stamp the deployed git SHA into apps/api/build-info.json.
//
// The web export is a *bonus* served from the same service as the API. The
// acceptance-critical surface is the API itself — GET /health and GET /version
// must stay healthy on every deploy. So a web-build failure is made NON-FATAL
// here: it is logged loudly, the version is still stamped, and the deploy
// proceeds API-only. The server already fails closed for a missing export —
// it serves a JSON service index at `/` and logs `web export: NOT FOUND` at
// boot (apps/api/src/server.js) — so operators still see, and can fix, the web
// failure without the whole deploy (and /version, /health, /me) going down.
//
// No secrets are read, printed, or written here.
import { spawnSync } from 'node:child_process';

function run(label, cmd, args) {
  console.log(`[build] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status === 0;
}

// 1. Web export — non-fatal. `build:web` = next build (apps/web) + hoist-theme-head.
const webOk = run('web export', 'npm', ['run', 'build:web']);
if (!webOk) {
  console.warn(
    '[build] web export build FAILED — deploying API-only. The server will ' +
      'serve a JSON index at `/` and log `web export: NOT FOUND` at boot; ' +
      '/health, /version, and /me are unaffected. Fix the web build to restore /login.'
  );
}

// 2. Version stamp — must succeed so /version reports the deployed SHA.
const stampOk = run('version stamp', 'node', ['scripts/write-version.mjs']);
if (!stampOk) {
  console.error('[build] version stamp FAILED');
  process.exit(1);
}

console.log(`[build] done (web export: ${webOk ? 'built' : 'skipped'}).`);
