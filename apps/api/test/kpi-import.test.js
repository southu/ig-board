import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  KPI_IMPORT_COLUMNS,
  ARCHIVE_MODEL_IMMUTABLE,
  deleteKpiImportAttempt,
  exportKpiImportRows,
  kpiImportContract,
  kpiImportTemplate,
  parseKpiImportCsv,
  updateKpiImportAttempt
} from '../src/kpiImport.js';
import { buildApp } from '../src/server.js';
import { databaseUrl } from '../src/db.js';

const SECRET = 'kpi-export-test-secret';
function roleToken(role) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({
    sub: `test-${role}`,
    email: `${role}@boardroom.test`,
    app_metadata: { role },
    exp: Math.floor(Date.now() / 1000) + 3600
  });
  const signature = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

test('KPI import CSV contract is deterministic and uses immutable ids', () => {
  assert.deepEqual(kpiImportContract(), kpiImportContract());
  assert.deepEqual(kpiImportContract().immutable_identifiers, ['kpi_id', 'member_id']);
  assert.equal(kpiImportContract().new_kpi_requires_blank_kpi_id, true);
  assert.equal(kpiImportTemplate(), `${KPI_IMPORT_COLUMNS.join(',')}\r\n`);
});

test('CSV parser returns structured field errors for invalid rows', () => {
  const parsed = parseKpiImportCsv(`${KPI_IMPORT_COLUMNS.join(',')}\n,,,,,,,,,,,,,,,`);
  assert.equal(parsed.rows.length, 1);
  assert.deepEqual(parsed.errors[0], { row: 2, field: 'kpi_name', code: 'required_for_new_kpi', message: 'new KPI rows require kpi_name and blank kpi_id' });
});

test('CSV exporter always emits the shared ordered columns', () => {
  assert.ok(exportKpiImportRows([{ kpi_id: 'immutable-id', kpi_name: 'Example' }]).startsWith(`${KPI_IMPORT_COLUMNS.join(',')}\r\n`));
});

test('shared CSV parser round-trips commas, quotes, line breaks, and unicode', () => {
  const source = {
    kpi_id: 'kpi-1', member_id: 'member-1', kpi_name: 'Café, "North"',
    member_name: 'Zoë\nExample', definition: 'first line\nsecond, "quoted"'
  };
  const parsed = parseKpiImportCsv(exportKpiImportRows([source]));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.rows[0].kpi_name, source.kpi_name);
  assert.equal(parsed.rows[0].member_name, source.member_name);
  assert.equal(parsed.rows[0].definition, source.definition);
});

test('admin KPI export uses the import schema and refuses non-admins', async (t) => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = buildApp({ logger: false });
  await app.ready();
  t.after(() => {
    app.close();
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });
  const denied = await app.inject({ method: 'GET', url: '/api/admin/kpi-export.csv', headers: { authorization: `Bearer ${roleToken('employee')}` } });
  assert.equal(denied.statusCode, 403);
  const response = await app.inject({ method: 'GET', url: '/api/admin/kpi-export.csv', headers: { authorization: `Bearer ${roleToken('admin')}` } });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/csv; charset=utf-8/i);
  assert.match(response.headers['content-disposition'], /kpi-import-\d{4}-\d{2}-\d{2}\.csv/);
  const parsed = parseKpiImportCsv(response.body);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(response.body.split('\r\n')[0].split(','), KPI_IMPORT_COLUMNS);
  assert.ok(parsed.rows.every((row) => row.kpi_id && row.member_id && row.kpi_name && row.member_name));
});

test('archive model rejects updates and deletes', () => {
  assert.equal(ARCHIVE_MODEL_IMMUTABLE, true);
  assert.throws(() => updateKpiImportAttempt(), /immutable/);
  assert.throws(() => deleteKpiImportAttempt(), /immutable/);
});

test('public import diagnostics are deterministic and contain no source data', async (t) => {
  const app = buildApp({ logger: false });
  await app.ready();
  t.after(() => app.close());
  const first = await app.inject('/api/kpi-import/contract');
  const second = await app.inject('/api/kpi-import/contract');
  assert.equal(first.statusCode, 200);
  assert.equal(first.body, second.body);
  const health = await app.inject('/api/kpi-import/foundation-health');
  assert.equal(health.statusCode, 200);
  assert.ok(!health.body.includes('DATABASE_URL'));
  assert.equal(JSON.parse(health.body).tests.durable_source_references, 'failing');
});

test('Railway Postgres service bindings configure the durable archive database', () => {
  assert.equal(
    databaseUrl({ PGHOST: 'postgres.railway.internal', PGPORT: '5432', PGUSER: 'postgres', PGDATABASE: 'railway' }),
    'postgresql://postgres@postgres.railway.internal:5432/railway'
  );
  assert.equal(databaseUrl({ POSTGRES_PRIVATE_URL: 'postgresql://private-host/db' }), 'postgresql://private-host/db');
});
