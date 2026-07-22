// Build-time helper: capture the deployed git SHA into a file the API can read
// at runtime as a fallback when no runtime env var is available.
//
// On Railway (GitHub-connected service) RAILWAY_GIT_COMMIT_SHA is injected at
// both build and run time; this simply records it so /version stays correct even
// if the runtime env is ever stripped. Never writes version.txt (reserved).
import { writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prefer the platform-injected commit SHA; fall back to the checked-out git
// HEAD so /version still reports the real deployed SHA on any builder (CI,
// local, or a Railway image that keeps .git) even if the env var is renamed.
function fromGit() {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore']
    })
      .toString()
      .trim();
  } catch {
    return '';
  }
}

const sha =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  process.env.GIT_SHA ||
  fromGit() ||
  '';

const out = join(__dirname, '..', 'apps', 'api', 'build-info.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ sha, builtAt: new Date().toISOString() }, null, 2) + '\n'
);

console.log(`[write-version] recorded sha=${sha || '(none)'} -> ${out}`);
