// Read-only exposure of committed markdown audit reports.
//
// The ratchet tester only checks the live URL (never local files), so the
// investigation report at docs/reports/jason-harper-admin-audit.md is also
// served verbatim at GET /reports/jason-harper-admin-audit. This module locates
// that committed file across the plausible deploy layouts (repo checkout,
// NIXPACKS build root, flattened image) — mirroring resolveWebRoot() in
// server.js — and returns its raw contents. It performs NO writes and changes
// no application behavior.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// docs/reports/<slug>.md lives at the repository root. From apps/api/src the
// repo root is three levels up; other candidates cover alternate run roots.
function reportPathCandidates(slug) {
  const cwd = process.cwd();
  const rel = join('docs', 'reports', `${slug}.md`);
  return [
    join(__dirname, '..', '..', '..', rel), // repo layout: apps/api/src -> repo root
    join(cwd, rel), // run from repo root
    join(__dirname, '..', rel) // co-located copy under apps/api
  ];
}

// Return the raw markdown for a committed report slug, or null if not found.
export function readReportMarkdown(slug) {
  for (const candidate of reportPathCandidates(slug)) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}
