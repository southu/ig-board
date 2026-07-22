#!/usr/bin/env bash
# scripts/seed-twice.sh
# Proves the seed is idempotent: applies the schema, runs the seed twice, and
# checks the per-table row counts are byte-for-byte identical between runs.
# Requires DATABASE_URL. Intended to also capture a transcript in transcripts/.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "=== ig-board seed idempotency check ==="
echo "date(UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo

echo "--- apply migrations ---"
node db/cli.js migrate
echo

echo "--- seed: run 1 ---"
node db/cli.js seed
node db/cli.js counts | tee /tmp/counts_run1.json
echo

echo "--- seed: run 2 ---"
node db/cli.js seed
node db/cli.js counts | tee /tmp/counts_run2.json
echo

echo "--- compare run1 vs run2 ---"
if diff -u /tmp/counts_run1.json /tmp/counts_run2.json; then
  echo "RESULT: PASS — identical row counts across both seed runs"
else
  echo "RESULT: FAIL — row counts differed between runs"
  exit 1
fi
