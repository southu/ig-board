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
  previewKpiImport,
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

test('persisted KPI name maps to kpi_name for unchanged import comparison', () => {
  const existing = {
    id: 'kpi-1', name: 'Revenue', member_id: 'member-1', key: 'revenue',
    definition: 'Monthly revenue', owner: 'Finance', cadence: 'monthly',
    direction: 'up_good', unit: 'USD', green_threshold: '10', yellow_threshold: '5',
    red_threshold: '1', target_min: '1', target_max: '10', notes: 'Current'
  };
  // This mirrors the server's persisted-KPI import contract mapping.
  const context = { kpis: [{ ...existing, kpi_name: existing.name }], members: [{ id: 'member-1', full_name: 'Admin' }] };
  const csv = `\uFEFF${exportKpiImportRows([{ kpi_id: 'kpi-1', member_id: 'member-1', kpi_name: ' Revenue ', member_name: 'Admin', key: ' revenue ', definition: 'Monthly revenue', owner: 'Finance', cadence: 'monthly', direction: 'up_good', unit: 'USD', green_threshold: '10', yellow_threshold: '5', red_threshold: '1', target_min: '1', target_max: '10', notes: 'Current' }])}`;
  const preview = previewKpiImport(csv, context);
  assert.deepEqual(preview.counts, { added: 0, updated: 0, unchanged: 1, rejected: 0 });
});

test('preview rejects duplicate ids, missing headers, unknown members, and mixed batches atomically', () => {
  const existing = { id: 'k1', member_id: 'm1', kpi_name: 'Revenue', key: 'revenue', direction: 'up_good' };
  const context = { kpis: [existing], members: [{ id: 'm1', full_name: 'Admin' }] };
  const row = (overrides = {}) => ({ kpi_id: 'k1', member_id: 'm1', kpi_name: 'Revenue', member_name: 'Admin', key: 'revenue', direction: 'up_good', ...overrides });
  const duplicate = previewKpiImport(exportKpiImportRows([row(), row()]), context);
  assert.equal(duplicate.counts.rejected, 2);
  assert.match(duplicate.rows[0].errors[0].code, /duplicate_kpi_id/);
  const missingHeader = previewKpiImport('kpi_id,member_id\nk1,m1\n', context);
  assert.ok(missingHeader.file_errors.some((error) => error.code === 'missing_required_header'));
  const unknown = previewKpiImport(exportKpiImportRows([row({ member_id: 'missing', member_name: 'Nobody' })]), context);
  assert.ok(unknown.rows[0].errors.some((error) => error.code === 'unknown_member_reference'));
  const mixed = previewKpiImport(exportKpiImportRows([row({ key: 'changed' }), row({ kpi_id: '', kpi_name: 'New KPI', key: 'new-kpi', member_id: 'missing', member_name: 'Nobody' })]), context);
  assert.equal(mixed.counts.updated, 1);
  assert.equal(mixed.counts.rejected, 1);
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

test('commit flow covers unchanged, updates, adds, validation failures, stale previews, and retries', async (t) => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = buildApp({ logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });
  const headers = { authorization: `Bearer ${roleToken('admin')}` };
  const upload = async (csv) => {
    const boundary = `kpi-test-${crypto.randomUUID()}`;
    const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="import.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`);
    const response = await app.inject({ method: 'POST', url: '/api/admin/kpi-import/preview', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body);
  };
  const commit = async (archiveId) => {
    const response = await app.inject({ method: 'POST', url: '/api/admin/kpi-import/commit', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify({ archive_id: archiveId }) });
    return { response, body: JSON.parse(response.body) };
  };
  const exported = await app.inject({ method: 'GET', url: '/api/admin/kpi-export.csv', headers });
  const rows = parseKpiImportCsv(exported.body).rows;
  const validRow = (row, overrides = {}) => ({ ...row, direction: row.direction || 'up_good', green_threshold: '', yellow_threshold: '', red_threshold: '', target_min: '', target_max: '', ...overrides });
  const unchanged = await upload(exportKpiImportRows([rows[0]]));
  const unchangedResult = await commit(unchanged.archive.id);
  assert.equal(unchangedResult.body.counts.unchanged, 1, JSON.stringify({ preview: unchanged, result: unchangedResult.body }));

  const updates = await upload(exportKpiImportRows([validRow(rows[1], { notes: 'first update' }), validRow(rows[2], { notes: 'second update' })]));
  const updated = await commit(updates.archive.id);
  assert.equal(updated.response.statusCode, 200, JSON.stringify({ preview: updates, result: updated.body }));
  assert.equal(updated.body.counts.updated, 2);

  const addedRow = validRow(rows[0], { kpi_id: '', kpi_name: 'Imported KPI', key: 'imported-kpi', direction: 'up_good', notes: 'added' });
  const added = await upload(exportKpiImportRows([addedRow]));
  const firstAdd = await commit(added.archive.id);
  const repeatAdd = await commit(added.archive.id);
  assert.equal(firstAdd.body.counts.added, 1);
  assert.equal(repeatAdd.body.idempotent, true);

  const duplicate = await upload(exportKpiImportRows([validRow(rows[3]), validRow(rows[3]) ]));
  const duplicateResult = await commit(duplicate.archive.id);
  assert.equal(duplicateResult.body.outcome, 'rejected');
  assert.ok(duplicateResult.body.errors.some((error) => error.code === 'duplicate_kpi_id'));
  const missing = await upload('kpi_id,member_id\nanything,anything\n');
  const missingResult = await commit(missing.archive.id);
  assert.ok(missingResult.body.errors.some((error) => error.code === 'missing_required_header'));
  const unknown = await upload(exportKpiImportRows([validRow(rows[4], { member_id: 'missing-member', member_name: 'Missing member' })]));
  assert.ok((await commit(unknown.archive.id)).body.errors.some((error) => error.code === 'unknown_member_reference'));
  const mixed = await upload(exportKpiImportRows([validRow(rows[5], { notes: 'must not apply' }), { ...addedRow, key: 'invalid-member-kpi', member_id: 'missing-member', member_name: 'Missing member' }]));
  const mixedResult = await commit(mixed.archive.id);
  assert.equal(mixedResult.body.outcome, 'rejected');
  assert.equal(mixedResult.body.counts.rejected, 1);

  const staleA = await upload(exportKpiImportRows([validRow(rows[6], { notes: 'stale A' })]));
  const staleB = await upload(exportKpiImportRows([validRow(rows[6], { notes: 'stale B' })]));
  assert.equal((await commit(staleB.archive.id)).body.outcome, 'committed');
  const staleResult = await commit(staleA.archive.id);
  assert.equal(staleResult.response.statusCode, 409);
  assert.equal(staleResult.body.outcome, 'stale');
  assert.ok(staleResult.body.errors.some((error) => error.code === 'stale_preview'));
});

test('archive model rejects updates and deletes', () => {
  assert.equal(ARCHIVE_MODEL_IMMUTABLE, true);
  assert.throws(() => updateKpiImportAttempt(), /immutable/);
  assert.throws(() => deleteKpiImportAttempt(), /immutable/);
});

test('admin archive lists newest attempts, exposes validation detail, and returns exact source bytes', async (t) => {
  const previous = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = SECRET;
  const app = buildApp({ logger: false });
  await app.ready();
  t.after(async () => {
    await app.close();
    if (previous === undefined) delete process.env.SUPABASE_JWT_SECRET;
    else process.env.SUPABASE_JWT_SECRET = previous;
  });
  const headers = { authorization: `Bearer ${roleToken('admin')}` };
  const upload = async (filename, csv) => {
    const boundary = `archive-test-${crypto.randomUUID()}`;
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(csv), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const response = await app.inject({ method: 'POST', url: '/api/admin/kpi-import/preview', headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    assert.equal(response.statusCode, 200);
    return JSON.parse(response.body).archive;
  };
  const firstBytes = `${KPI_IMPORT_COLUMNS.join(',')}\r\n,,,,,,,,,,,,,,,\r\n`;
  const first = await upload('failed upload.csv', firstBytes);
  const second = await upload('second.csv', 'kpi_id,member_id\nanything,anything\n');
  const list = await app.inject({ method: 'GET', url: '/api/admin/kpi-import/archives', headers });
  assert.equal(list.statusCode, 200);
  const archives = JSON.parse(list.body).archives;
  assert.equal(archives[0].id, second.id);
  assert.equal(archives[1].id, first.id);
  assert.deepEqual(Object.keys(archives[0].counts).sort(), ['added', 'rejected', 'unchanged', 'updated']);
  const detail = await app.inject({ method: 'GET', url: `/api/admin/kpi-import/archives/${first.id}`, headers });
  assert.equal(detail.statusCode, 200);
  assert.ok(JSON.parse(detail.body).validation_errors.some((error) => error.row === 2));
  const download = await app.inject({ method: 'GET', url: `/api/admin/kpi-import/archives/${first.id}/download`, headers });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, Buffer.from(firstBytes));
  for (const url of ['/api/admin/kpi-import/archives', `/api/admin/kpi-import/archives/${first.id}`, `/api/admin/kpi-import/archives/${first.id}/download`]) {
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${roleToken('employee')}` } })).statusCode, 403);
  }
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
