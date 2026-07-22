// Resolve the deployed git SHA for the /version endpoint.
//
// Priority:
//   1. Runtime env injected by Railway (GitHub-connected service) or CI.
//   2. build-info.json written at build time by scripts/write-version.mjs.
//   3. "unknown" (endpoint still returns 200 so /health-style probes pass).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fromEnv() {
  return (
    process.env.RAILWAY_GIT_COMMIT_SHA ||
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
  const sha = fromEnv() || fromBuildInfo() || 'unknown';
  return {
    sha,
    version: sha,
    commit: sha,
    service: 'ig-board-api'
  };
}
