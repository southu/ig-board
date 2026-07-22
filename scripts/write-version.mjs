// Build-time helper: capture the deployed git SHA into a file the API can read
// at runtime as a fallback when no runtime env var is available.
//
// On Railway (GitHub-connected service) RAILWAY_GIT_COMMIT_SHA is injected at
// both build and run time; this simply records it so /version stays correct even
// if the runtime env is ever stripped. Never writes version.txt (reserved).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const sha =
  process.env.RAILWAY_GIT_COMMIT_SHA ||
  process.env.GIT_COMMIT_SHA ||
  process.env.SOURCE_VERSION ||
  process.env.GIT_SHA ||
  '';

const out = join(__dirname, '..', 'apps', 'api', 'build-info.json');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify({ sha, builtAt: new Date().toISOString() }, null, 2) + '\n'
);

console.log(`[write-version] recorded sha=${sha || '(none)'} -> ${out}`);
