import test from 'node:test';
import assert from 'node:assert/strict';
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
