// Resolve the deployed git SHA for the /version endpoint.
//
// Priority:
//   1. RAILWAY_GIT_COMMIT_SHA — injected by Railway for the *current* deploy, so
//      it is always the truth when present.
//   2. build-info.json — stamped at build time by scripts/write-version.mjs from
//      the actual deployed commit. This is preferred over the manual override env
//      vars below because those (notably a GIT_COMMIT_SHA set as a persistent
//      Railway *service variable* by an imperative deploy) can go stale and then
//      report a commit that is no longer the one running.
//   3. Manual override env vars (GIT_COMMIT_SHA / SOURCE_VERSION / GIT_SHA) — a
//      last-resort fallback for deploy paths that stamp neither of the above.
//   4. "unknown" (endpoint still returns 200 so /health-style probes pass).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fromRailwayEnv() {
  return (process.env.RAILWAY_GIT_COMMIT_SHA || '').trim();
}

function fromOverrideEnv() {
  return (
    process.env.GIT_COMMIT_SHA ||
    process.env.SOURCE_VERSION ||
    process.env.GIT_SHA ||
    ''
  ).trim();
}

function fromBuildInfo() {
  try {
    const raw = readFileSync(join(__dirname, '..', 'build-info.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return (parsed.sha || '').trim();
  } catch {
    return '';
  }
}

export function resolveVersion() {
  const sha =
    fromRailwayEnv() || fromBuildInfo() || fromOverrideEnv() || 'unknown';
  return {
    sha,
    version: sha,
    commit: sha,
    service: 'ig-board-api'
  };
}
