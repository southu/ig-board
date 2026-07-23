// Unit tests for resolveVersion() priority (src/version.js).
//
// These lock the regression that kept /version reporting a stale commit: a
// GIT_COMMIT_SHA left over as a persistent Railway service variable must NOT
// win over the build-time stamp (build-info.json) or the current-deploy env
// (RAILWAY_GIT_COMMIT_SHA).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveVersion } from '../src/version.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildInfoPath = join(__dirname, '..', 'build-info.json');

const ENV_KEYS = [
  'RAILWAY_GIT_COMMIT_SHA',
  'GIT_COMMIT_SHA',
  'SOURCE_VERSION',
  'GIT_SHA'
];

// Snapshot + clear the SHA env vars and any existing build-info.json so each
// test controls the full resolution surface, then restore on teardown.
function isolate(t) {
  const prevEnv = {};
  for (const k of ENV_KEYS) {
    prevEnv[k] = process.env[k];
    delete process.env[k];
  }
  const prevBuildInfo = existsSync(buildInfoPath)
    ? readFileSync(buildInfoPath, 'utf8')
    : null;
  if (prevBuildInfo !== null) rmSync(buildInfoPath);

  t.after(() => {
    for (const k of ENV_KEYS) {
      if (prevEnv[k] === undefined) delete process.env[k];
      else process.env[k] = prevEnv[k];
    }
    if (prevBuildInfo !== null) writeFileSync(buildInfoPath, prevBuildInfo);
    else if (existsSync(buildInfoPath)) rmSync(buildInfoPath);
  });

  return {
    writeBuildInfo: (sha) =>
      writeFileSync(buildInfoPath, JSON.stringify({ sha }) + '\n')
  };
}

test('RAILWAY_GIT_COMMIT_SHA wins over every other source', (t) => {
  const { writeBuildInfo } = isolate(t);
  writeBuildInfo('from-build-info');
  process.env.GIT_COMMIT_SHA = 'stale-service-var';
  process.env.RAILWAY_GIT_COMMIT_SHA = 'current-deploy';
  assert.equal(resolveVersion().sha, 'current-deploy');
});

test('build-info.json wins over a stale GIT_COMMIT_SHA service variable', (t) => {
  const { writeBuildInfo } = isolate(t);
  writeBuildInfo('true-deployed-sha');
  process.env.GIT_COMMIT_SHA = 'stale-service-var';
  assert.equal(resolveVersion().sha, 'true-deployed-sha');
});

test('GIT_COMMIT_SHA is used only when nothing higher-priority exists', (t) => {
  const { writeBuildInfo } = isolate(t);
  // no build-info written, no RAILWAY var set
  process.env.GIT_COMMIT_SHA = 'override-fallback';
  assert.equal(resolveVersion().sha, 'override-fallback');
  void writeBuildInfo;
});

test('falls back to "unknown" when no source is available', (t) => {
  isolate(t);
  assert.equal(resolveVersion().sha, 'unknown');
});
