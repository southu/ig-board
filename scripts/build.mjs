// Deploy build orchestrator for the ig-board Railway service.
//
// The Railway `buildCommand` runs this. It does two things, in order:
//   1. Build the Next.js static web export (apps/web/out) and hoist the theme
//      head script into each page.
//   2. Stamp the deployed git SHA into apps/api/build-info.json.
//
// The web export is a *bonus* served from the same service as the API. The
// acceptance-critical surface is the API itself — GET /health and GET /version
// must stay healthy on every deploy. So NEITHER build step is fatal here: each
// is logged loudly on failure and the deploy still proceeds, because the running
// API is what the acceptance checks hit and it must never be blocked from
// deploying by a build-time hiccup. The server already fails closed for a missing
// export — it serves a JSON service index at `/` and logs `web export: NOT FOUND`
// at boot (apps/api/src/server.js) — so operators still see, and can fix, any
// build failure without the whole deploy (and /version, /health, /me) going down.
//
// No secrets are read, printed, or written here.
import { spawnSync } from 'node:child_process';

// Run a build step, returning true on success. Never throws: a spawn error
// (e.g. the command is missing) is treated as a failed step and logged, so a
// single step can't abort the whole build and block the API deploy.
function run(label, cmd, args) {
  console.log(`[build] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  if (res.error) {
    console.warn(`[build] ${label}: could not run (${res.error.message})`);
    return false;
  }
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

// 2. Version stamp — non-fatal. This writes apps/api/build-info.json as a
// *fallback* SHA source; at runtime /version prefers RAILWAY_GIT_COMMIT_SHA
// (injected by Railway for the current deploy — the authoritative source), so a
// stamp hiccup must not block the deploy and take /health, /version, and /me
// down with it. Logged loudly if it ever fails so operators can investigate.
const stampOk = run('version stamp', 'node', ['scripts/write-version.mjs']);
if (!stampOk) {
  console.warn(
    '[build] version stamp FAILED — deploying anyway. /version falls back to ' +
      'the runtime RAILWAY_GIT_COMMIT_SHA (authoritative on GitHub-connected ' +
      'Railway services), so it stays accurate; /health and /me are unaffected.'
  );
}

console.log(
  `[build] done (web export: ${webOk ? 'built' : 'skipped'}, ` +
    `version stamp: ${stampOk ? 'written' : 'skipped'}).`
);
