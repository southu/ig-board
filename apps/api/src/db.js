// Optional Postgres access for the governance data layer.
//
// The live service may bind DATABASE_URL (Railway Postgres). When present we
// apply SQL migrations on boot and serve governance status from the DB. When
// absent (unit tests, un-provisioned local runs) callers fall back to the
// in-process governance store — the API still boots and /health stays green.
//
// Dependency: `pg`. Connection strings and passwords are never logged.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool = null;
let migratePromise = null;
let lastMigrateError = null;

export function databaseUrl(env = process.env) {
  // Railway's Postgres plugin exposes DATABASE_URL when explicitly referenced,
  // but service-to-service bindings may instead expose one of these standard
  // URL names or the individual PG* variables.  Support each form so an API
  // deployment cannot silently fall back to volatile memory merely because the
  // binding was created through Railway's UI rather than as DATABASE_URL.
  const direct = [
    env.DATABASE_URL,
    env.DATABASE_PRIVATE_URL,
    env.POSTGRES_URL,
    env.POSTGRES_PRIVATE_URL
  ].find((value) => typeof value === 'string' && value.trim());
  if (direct) return direct.trim();

  if (!env.PGHOST || !env.PGUSER || !env.PGDATABASE) return '';
  const port = String(env.PGPORT || '5432');
  const auth = env.PGPASSWORD
    ? `${encodeURIComponent(env.PGUSER)}:${encodeURIComponent(env.PGPASSWORD)}@`
    : `${encodeURIComponent(env.PGUSER)}@`;
  return `postgresql://${auth}${env.PGHOST}:${port}/${encodeURIComponent(env.PGDATABASE)}`;
}

export function isDatabaseConfigured(env = process.env) {
  return Boolean(databaseUrl(env));
}

// Resolve the migrations directory across repo / workspace layouts.
export function migrationsDir() {
  const candidates = [
    join(__dirname, '..', '..', '..', 'supabase', 'migrations'), // apps/api/src -> repo
    join(process.cwd(), 'supabase', 'migrations'),
    join(process.cwd(), '..', '..', 'supabase', 'migrations')
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
}

// Migrations the API applies on boot. We only auto-run the governance data
// layer migration here: earlier 0001–0007 files target a full Supabase bootstrap
// (auth roles, RLS) and are applied out-of-band via `supabase/seed.sh`. 0008 is
// self-contained (CREATE IF NOT EXISTS + idempotent backfill) and safe on both
// fresh Railway Postgres and already-seeded projects.
export function listMigrationFiles(dir = migrationsDir()) {
  return readdirSync(dir)
    .filter((f) => f === '0008_governance.sql' || f === '0009_kpi_import_archives.sql' || f === '0010_kpi_import_archive_hardening.sql' || f === '0011_kpi_import_archive_repair.sql' || f === '0012_kpi_import_archive_production_enforcement.sql')
    .sort()
    .map((f) => join(dir, f));
}

export function getPool(env = process.env) {
  const url = databaseUrl(env);
  if (!url) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: url,
    // Railway / managed Postgres often require SSL; local dev usually does not.
    ssl: /localhost|127\.0\.0\.1/i.test(url)
      ? false
      : { rejectUnauthorized: false },
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000
  });
  pool.on('error', (err) => {
    // Prevent unhandled pool errors from crashing the process after boot.
    console.error('[db] idle client error:', err && err.message);
  });
  return pool;
}

// Close the pool (tests / graceful shutdown). Safe when never opened.
export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  migratePromise = null;
  try {
    await p.end();
  } catch {
    /* ignore */
  }
}

// Apply every migration file in order. Each file is executed as a single
// multi-statement query. Idempotent migrations (IF NOT EXISTS / DO blocks)
// make re-runs on every boot safe. Tracks applied basenames in
// public.schema_migrations so we can skip already-applied files when they
// are expensive — but 0008 and friends are cheap, so we also tolerate
// re-applying everything if the tracking table is missing mid-upgrade.
export async function applyMigrations(env = process.env) {
  if (migratePromise) return migratePromise;
  migratePromise = (async () => {
    lastMigrateError = null;
    const p = getPool(env);
    if (!p) {
      return { ok: true, skipped: true, reason: 'no_database_url' };
    }
    const client = await p.connect();
    try {
      await client.query(`
        create table if not exists public.schema_migrations (
          filename text primary key,
          applied_at timestamptz not null default now()
        )
      `);

      const files = listMigrationFiles();
      const applied = new Set(
        (await client.query('select filename from public.schema_migrations')).rows.map(
          (r) => r.filename
        )
      );

      const ran = [];
      for (const filePath of files) {
        const filename = filePath.split(/[/\\]/).pop();
        // Always re-apply the governance migration so role backfill stays
        // correct after new users appear; other migrations skip once applied.
        const force = filename === '0008_governance.sql';
        if (applied.has(filename) && !force) continue;

        const sql = readFileSync(filePath, 'utf8');
        await client.query('begin');
        try {
          await client.query(sql);
          await client.query(
            `insert into public.schema_migrations (filename)
             values ($1)
             on conflict (filename) do update set applied_at = now()`,
            [filename]
          );
          await client.query('commit');
          ran.push(filename);
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      }
      return { ok: true, skipped: false, ran };
    } catch (err) {
      lastMigrateError = err;
      console.error('[db] migration failed:', err && err.message);
      return { ok: false, error: err && err.message };
    } finally {
      client.release();
    }
  })();
  try {
    return await migratePromise;
  } finally {
    // Allow a later boot retry after failure; success stays cached via applied set.
    if (lastMigrateError) migratePromise = null;
  }
}

export function getLastMigrateError() {
  return lastMigrateError;
}

// Run a parameterized query. Returns { rows } or throws.
export async function query(text, params = [], env = process.env) {
  const p = getPool(env);
  if (!p) {
    const err = new Error('DATABASE_URL is not set');
    err.code = 'NO_DATABASE';
    throw err;
  }
  return p.query(text, params);
}
