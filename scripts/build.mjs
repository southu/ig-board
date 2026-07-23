// Deploy build orchestrator for the ig-board Railway service.
//
// The Railway `buildCommand` runs this. By default it does exactly ONE thing:
//   1. Stamp the deployed git SHA into apps/api/build-info.json.
//
// It intentionally does NOT run `next build` on the deploy path. The web app is
// served from the *committed* static export in apps/api/public (built locally
// from apps/web/out with `npm run build:web` and checked into the repo), which
// the server resolves as a web root (apps/api/src/server.js). This is a
// deliberate, hard-won choice: the constrained Railway NIXPACKS builder OOMs
// during `next build`, and when the OOM-killer takes the whole build process
// tree the deploy FAILS and Railway rolls back — freezing production on a stale
// image. `run()`'s non-fatal handling only catches a non-zero *child* exit, not
// the parent being killed, so no amount of in-script guarding fully absorbs it.
// Shipping the export as committed bytes removes `next build` from the critical
// path entirely: the deploy build becomes a tiny, memory-trivial stamp that
// cannot OOM, so every push actually deploys and the web app (/, /login, theme)
// is always served.
//
// Freshness is a build-time concern, not a deploy-time one: whoever changes
// apps/web/** rebuilds and re-commits apps/api/public (`npm run build:web` then
// copy apps/web/out -> apps/api/public). To additionally rebuild the export here
// (e.g. a CI runner with ample memory), set BUILD_WEB=1; it stays non-fatal.
//
// No secrets are read, printed, or written here.
import { spawnSync } from 'node:child_process';

// Run a build step, returning true on success. Never throws: a spawn error
// (e.g. the command is missing) is treated as a failed step and logged, so a
// single step can't abort the whole build and block the API deploy. `extraEnv`
// is merged onto the child environment for that step only.
function run(label, cmd, args, extraEnv = {}) {
  console.log(`[build] ${label}: ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  if (res.error) {
    console.warn(`[build] ${label}: could not run (${res.error.message})`);
    return false;
  }
  return res.status === 0;
}

// 1. Version stamp — non-fatal, and first so the acceptance-critical /version
// fallback is written before the heavier web build runs. This writes
// apps/api/build-info.json as a *fallback* SHA source; at runtime /version
// prefers RAILWAY_GIT_COMMIT_SHA (injected by Railway for the current deploy —
// the authoritative source), so a stamp hiccup must not block the deploy and
// take /health, /version, and /me down with it. Logged loudly if it ever fails.
const stampOk = run('version stamp', 'node', ['scripts/write-version.mjs']);
if (!stampOk) {
  console.warn(
    '[build] version stamp FAILED — deploying anyway. /version falls back to ' +
      'the runtime RAILWAY_GIT_COMMIT_SHA (authoritative on GitHub-connected ' +
      'Railway services), so it stays accurate; /health and /me are unaffected.'
  );
}

// 2. Web export — SKIPPED on the deploy path by default (see header). The web
// app is served from the committed apps/api/public export, so `next build` never
// runs here and thus can never OOM-kill the deploy. Opt in with BUILD_WEB=1 on a
// host with adequate memory (local/CI); it stays non-fatal even then. Spawned
// with telemetry off + CI mode and a bounded heap so a runaway build GCs hard
// instead of tripping the OOM-killer.
let webBuilt = false;
if (/^(1|true|yes)$/i.test((process.env.BUILD_WEB || '').trim())) {
  const webBuildEnv = {
    NEXT_TELEMETRY_DISABLED: '1',
    CI: '1',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=768`.trim()
  };
  webBuilt = run('web export', 'npm', ['run', 'build:web'], webBuildEnv);
  if (!webBuilt) {
    console.warn(
      '[build] web export build FAILED — falling back to the committed ' +
        'apps/api/public export, which the server serves unchanged. /health, ' +
        '/version, /login and the themed shell are all unaffected.'
    );
  }
} else {
  console.log(
    '[build] web export: serving committed apps/api/public (next build skipped; ' +
      'set BUILD_WEB=1 to rebuild it here).'
  );
}

console.log(
  `[build] done (web export: ${webBuilt ? 'rebuilt' : 'committed'}, ` +
    `version stamp: ${stampOk ? 'written' : 'skipped'}).`
);
