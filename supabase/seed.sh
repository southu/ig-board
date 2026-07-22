#!/usr/bin/env bash
# Thin wrapper around the single idempotent seed script (supabase/seed.sql).
# Applies migrations first (idempotent) then seeds. Safe to run repeatedly.
#
# Usage:
#   DATABASE_URL=postgres://... ./supabase/seed.sh
#
# Requires: psql on PATH and a DATABASE_URL to a Postgres/Supabase database.
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to your Postgres/Supabase connection string}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Applying migrations"
for f in "$here"/migrations/*.sql; do
  echo "    - $(basename "$f")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
done

echo "==> Seeding (idempotent)"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$here/seed.sql"

echo "==> Done"
