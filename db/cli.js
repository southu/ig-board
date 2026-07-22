#!/usr/bin/env node
// db/cli.js — schema migration + seed + row-count + RLS-probe runner.
//
// Usage:
//   node db/cli.js migrate     apply every db/migrations/*.sql in order
//   node db/cli.js seed        apply db/seed/seed.sql (idempotent)
//   node db/cli.js counts      print per-table row counts as JSON
//   node db/cli.js probe       run the RLS probes (anon / board / audit)
//
// Connection comes from DATABASE_URL. Everything is idempotent.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const SEED_FILE = path.join(__dirname, 'seed', 'seed.sql');

const TABLES = [
  'users', 'layers', 'kpis', 'kpi_values', 'memos',
  'analyses', 'comments', 'agendas', 'audit_log',
];

function connectionConfig() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  // Railway public proxy / Supabase use TLS; internal networking does not.
  const needsSsl = /sslmode=require/.test(url) ||
    (/\brailway\b/.test(url) && !/\.railway\.internal/.test(url)) ||
    /supabase\.co/.test(url);
  return { connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : false };
}

async function withClient(fn) {
  const client = new Client(connectionConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function migrate(client) {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    process.stdout.write(`  applying ${f} ... `);
    await client.query(sql);
    process.stdout.write('ok\n');
  }
}

async function seed(client) {
  const sql = fs.readFileSync(SEED_FILE, 'utf8');
  await client.query(sql);
}

async function counts(client) {
  const out = {};
  for (const t of TABLES) {
    const r = await client.query(`select count(*)::int as n from public.${t}`);
    out[t] = r.rows[0].n;
  }
  return out;
}

// ---- RLS probes -----------------------------------------------------------
// We assert deny-by-default by SET ROLE-ing into anon / authenticated inside a
// superuser session (once SET ROLE lands on a non-owner, non-superuser role,
// RLS is enforced for that role). Probe fixture users are created in a savepoint
// and rolled back so seed counts are never disturbed.

async function setClaims(client, claims) {
  await client.query('select set_config($1, $2, true)', [
    'request.jwt.claims', JSON.stringify(claims),
  ]);
}

async function probe(client) {
  const results = [];
  const record = (name, pass, detail) => {
    results.push({ name, pass, detail });
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name} — ${detail}`);
  };

  // Fixture founder + board users (rolled back at the end).
  await client.query('begin');
  await client.query('savepoint probe');
  const founder = (await client.query(
    `insert into public.users (email, full_name, role)
     values ('probe-founder@example.com', 'Probe Founder', 'founder')
     returning id`)).rows[0].id;
  const board = (await client.query(
    `insert into public.users (email, full_name, role)
     values ('probe-board@example.com', 'Probe Board', 'board')
     returning id`)).rows[0].id;
  const kpiId = (await client.query(
    `select id from public.kpis order by sort_order limit 1`)).rows[0].id;

  // Run one statement inside its own savepoint so an expected DB error (RLS or
  // permission denial) does not poison the surrounding transaction. Returns
  // { ok, rowCount, error }. A blocked op => ok:false OR rowCount:0.
  const stmt = async (sql, params) => {
    await client.query('savepoint s');
    try {
      const r = await client.query(sql, params || []);
      await client.query('release savepoint s');
      return { ok: true, rowCount: r.rowCount, error: null };
    } catch (e) {
      await client.query('rollback to savepoint s');
      await client.query('release savepoint s');
      return { ok: false, rowCount: 0, error: e.message };
    }
  };
  const denied = (r) => r.ok === false || r.rowCount === 0; // errored or RLS-filtered

  // Seed one audit row up front (as the migration/owner role) so the immutability
  // checks have a row to attempt to tamper with.
  await client.query(
    `insert into public.audit_log (actor_id, actor_role, action, entity_type, entity_id)
     values ($1, 'founder', 'seed.probe', 'kpi', $2)`, [founder, kpiId]);

  // 1) anon reads zero rows from every table -------------------------------
  await client.query("select set_config('request.jwt.claims', '', true)");
  await client.query('set role anon');
  let anonOk = true;
  const anonDetail = [];
  for (const t of TABLES) {
    const r = await stmt(`select count(*)::int n from public.${t}`);
    // anon holds the SELECT grant, so the query succeeds but RLS yields 0 rows.
    // If it were instead denied outright, that also means "no rows" for anon.
    const rows = r.ok
      ? (await client.query(`select count(*)::int n from public.${t}`)).rows[0].n
      : 'denied';
    anonDetail.push(`${t}=${rows}`);
    if (rows !== 0 && rows !== 'denied') anonOk = false;
  }
  await client.query('reset role');
  record('anon sees zero rows from every table', anonOk, anonDetail.join(' '));

  // 2) board CANNOT insert kpi_values --------------------------------------
  await setClaims(client, { sub: board, role: 'authenticated' });
  await client.query('set role authenticated');
  const boardInsert = await stmt(
    `insert into public.kpi_values (kpi_id, period_start, value)
     values ($1, current_date, 1)`, [kpiId]);
  await client.query('reset role');
  record('board CANNOT insert kpi_values', denied(boardInsert),
    denied(boardInsert) ? 'insert rejected by RLS' : 'insert unexpectedly succeeded');

  // 3) board CANNOT update kpis --------------------------------------------
  await setClaims(client, { sub: board, role: 'authenticated' });
  await client.query('set role authenticated');
  const boardUpdate = await stmt(
    `update public.kpis set name = name || ' (edit)' where id = $1`, [kpiId]);
  await client.query('reset role');
  record('board CANNOT update kpis', denied(boardUpdate),
    `${boardUpdate.rowCount} row(s) updated (expected 0 — RLS filters the row)`);

  // 4) founder CAN insert kpi_values (sanity: policies are not over-broad) --
  await setClaims(client, { sub: founder, role: 'authenticated' });
  await client.query('set role authenticated');
  const founderInsert = await stmt(
    `insert into public.kpi_values (kpi_id, period_start, value, recorded_by)
     values ($1, current_date, 42, $2)`, [kpiId, founder]);
  await client.query('reset role');
  record('founder CAN insert kpi_values', founderInsert.ok,
    founderInsert.ok ? 'insert allowed by RLS' : `blocked: ${founderInsert.error}`);

  // 5) audit_log UPDATE/DELETE denied for every role -----------------------
  const auditRoles = ['authenticated', 'anon', 'service_role'];
  let auditImmutable = true;
  const auditDetail = [];
  for (const role of auditRoles) {
    if (role === 'authenticated') await setClaims(client, { sub: founder, role: 'authenticated' });
    await client.query(`set role ${role}`);
    const upd = await stmt(`update public.audit_log set action = 'tamper'`);
    const del = await stmt(`delete from public.audit_log`);
    await client.query('reset role');
    const updBlocked = denied(upd);
    const delBlocked = denied(del);
    auditDetail.push(`${role}:upd=${updBlocked ? 'denied' : 'ALLOWED'},del=${delBlocked ? 'denied' : 'ALLOWED'}`);
    if (!updBlocked || !delBlocked) auditImmutable = false;
  }
  record('audit_log UPDATE/DELETE denied for all roles', auditImmutable, auditDetail.join(' '));

  await client.query('rollback to savepoint probe');
  await client.query('rollback');

  const allPass = results.every((r) => r.pass);
  console.log(`\n  ${allPass ? 'ALL PROBES PASSED' : 'SOME PROBES FAILED'}`);
  if (!allPass) process.exitCode = 1;
  return results;
}

async function main() {
  const cmd = process.argv[2];
  await withClient(async (client) => {
    switch (cmd) {
      case 'migrate':
        await migrate(client);
        break;
      case 'seed':
        await seed(client);
        break;
      case 'counts':
        console.log(JSON.stringify(await counts(client), null, 2));
        break;
      case 'probe':
        await probe(client);
        break;
      default:
        console.error('usage: node db/cli.js <migrate|seed|counts|probe>');
        process.exitCode = 2;
    }
  });
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
