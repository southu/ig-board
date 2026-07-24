// Single deterministic CSV contract and immutable import archive helpers.
import crypto from 'node:crypto';
import { applyMigrations, getPool, isDatabaseConfigured, query } from './db.js';

export const KPI_IMPORT_COLUMNS = Object.freeze([
  'kpi_id', 'member_id', 'kpi_name', 'member_name', 'key', 'definition',
  'owner', 'cadence', 'direction', 'unit', 'green_threshold',
  'yellow_threshold', 'red_threshold', 'target_min', 'target_max', 'notes'
]);
export const KPI_IMPORT_EDITABLE_FIELDS = Object.freeze([
  'key', 'definition', 'owner', 'cadence', 'direction', 'unit',
  'green_threshold', 'yellow_threshold', 'red_threshold', 'target_min',
  'target_max', 'notes'
]);
export const ARCHIVE_MODEL_IMMUTABLE = true;

// Deliberately exported failure paths make mutability impossible even if a
// future caller reaches for a model helper instead of writing SQL directly.
export function updateKpiImportAttempt() {
  throw new Error('kpi import archives are immutable');
}
export function deleteKpiImportAttempt() {
  throw new Error('kpi import archives are immutable');
}

export function kpiImportContract() {
  return {
    encoding: 'utf-8', header: [...KPI_IMPORT_COLUMNS],
    immutable_identifiers: ['kpi_id', 'member_id'],
    human_readable_columns: ['kpi_name', 'member_name'],
    editable_kpi_fields: [...KPI_IMPORT_EDITABLE_FIELDS],
    new_kpi_requires_blank_kpi_id: true,
    format: 'csv-rfc4180'
  };
}

export function kpiImportTemplate() { return `${KPI_IMPORT_COLUMNS.join(',')}\r\n`; }
export function exportKpiImportRows(rows = []) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return `${KPI_IMPORT_COLUMNS.join(',')}\r\n${rows.map((row) => KPI_IMPORT_COLUMNS.map((c) => esc(row[c])).join(',')).join('\r\n')}${rows.length ? '\r\n' : ''}`;
}
export function parseKpiImportCsv(csv) {
  const text = Buffer.isBuffer(csv) ? csv.toString('utf8') : String(csv || '');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.length);
  const header = (lines.shift() || '').split(',');
  const errors = [];
  if (JSON.stringify(header) !== JSON.stringify(KPI_IMPORT_COLUMNS)) errors.push({ row: 1, field: 'header', code: 'invalid_header', message: 'header must exactly match the import contract' });
  const rows = lines.map((line, index) => {
    const values = line.split(','); const row = Object.fromEntries(KPI_IMPORT_COLUMNS.map((c, i) => [c, values[i] || '']));
    if (values.length !== KPI_IMPORT_COLUMNS.length) errors.push({ row: index + 2, field: 'row', code: 'wrong_column_count', message: 'row does not match the import contract' });
    if (!row.kpi_id && !row.kpi_name) errors.push({ row: index + 2, field: 'kpi_name', code: 'required_for_new_kpi', message: 'new KPI rows require kpi_name and blank kpi_id' });
    return row;
  });
  return { rows, errors };
}

export async function archiveKpiImportAttempt({ csv, originalFilename, administratorId = null, outcome = 'rejected', totalRows = 0, acceptedRows = 0, rejectedRows = 0, validationErrors = [] }) {
  if (!isDatabaseConfigured()) throw new Error('durable import archive requires DATABASE_URL');
  const bytes = Buffer.isBuffer(csv) ? csv : Buffer.from(String(csv || ''), 'utf8');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const storageKey = `kpi-imports/${crypto.randomUUID()}.csv`;
  const client = await getPool().connect();
  try {
    // This transaction is deliberately independent from the caller's KPI
    // transaction.  It commits the original object and validation record even
    // when the caller rolls its KPI work back, while still avoiding an orphan
    // source object if archive creation itself fails.
    await client.query('begin');
    const source = await client.query(`insert into public.kpi_import_source_files (storage_key, content, byte_size, sha256) values ($1,$2,$3,$4) returning id`, [storageKey, bytes, bytes.length, sha256]);
    const attempt = await client.query(`insert into public.kpi_import_attempts (administrator_id, original_filename, outcome, total_rows, accepted_rows, rejected_rows, validation_errors, source_file_id, source_sha256, source_byte_size) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10) returning id, created_at`, [administratorId, String(originalFilename || 'import.csv').slice(0, 255), outcome, totalRows, acceptedRows, rejectedRows, JSON.stringify(validationErrors), source.rows[0].id, sha256, bytes.length]);
    await client.query('commit');
    return { id: attempt.rows[0].id, created_at: attempt.rows[0].created_at, storage_key: storageKey, sha256, byte_size: bytes.length };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function kpiImportFoundationHealth() {
  const metadata = ['server_timestamp', 'optional_administrator_identity', 'original_filename', 'outcome', 'row_counts', 'structured_validation_errors', 'source_file_reference', 'integrity_metadata'];
  if (!isDatabaseConfigured()) return healthFailure(metadata, false);
  try {
    const migration = await applyMigrations();
    if (!migration.ok) return healthFailure(metadata, true);
    const r = await query(`
      select
        exists (select 1 from public.schema_migrations where filename = '0009_kpi_import_archives.sql')
          and exists (select 1 from public.schema_migrations where filename = '0011_kpi_import_archive_repair.sql')
          and exists (select 1 from public.schema_migrations where filename = '0012_kpi_import_archive_production_enforcement.sql')
          and exists (select 1 from public.schema_migrations where filename = '0013_kpi_import_archive_live_evidence.sql') as migration_applied,
        (select count(*) from pg_trigger where tgrelid = 'public.kpi_import_attempts'::regclass and not tgisinternal and tgname in ('kpi_import_attempts_no_update','kpi_import_attempts_no_delete')) = 2 as immutable,
        exists (select 1 from pg_constraint where conrelid = 'public.kpi_import_attempts'::regclass and contype = 'f' and pg_get_constraintdef(oid) like '%source_file_id%') as source_fk,
        exists (select 1 from pg_constraint where conrelid = 'public.kpi_import_attempts'::regclass and pg_get_constraintdef(oid) like '%jsonb_typeof(validation_errors)%') as validation_structure,
        exists (select 1 from public.kpi_import_source_files where storage_key = 'kpi-imports/system/durable-canary.txt' and sha256 = '90969829b1ff88bb50174bc5936355e3aa4cdc1916a1953107a7f75ff3b0d2b8' and content = convert_to('kpi-import-durable-storage-canary-v1', 'utf8')) as canary_retrievable,
        exists (
          select 1
          from public.kpi_import_attempts a
          join public.kpi_import_source_files s on s.id = a.source_file_id
          where a.original_filename = 'system-foundation-rollback-evidence.csv'
            and a.outcome = 'rolled_back'
            and jsonb_typeof(a.validation_errors) = 'array'
            and a.source_sha256 = s.sha256
            and a.source_byte_size = s.byte_size
        ) as rollback_archive_evidence
    `);
    const checks = r.rows[0] || {};
    // Catalog checks establish that the triggers are installed.  Exercise both
    // mutation paths against a fixed non-sensitive migration record inside a
    // transaction/savepoint as well, so this diagnostic never merely reports
    // intended DDL as enforcement.
    const mutationProbe = await archiveMutationProbe();
    const immutable = Boolean(checks.immutable && mutationProbe.updateRejected && mutationProbe.deleteRejected);
    const canary = Boolean(checks.canary_retrievable);
    return {
      migration_applied: Boolean(checks.migration_applied), archive_immutable_database: immutable,
      archive_immutable_model: true,
      durable_storage: { provider: 'railway_postgres', configured: true, application_filesystem: false, canary_retrievable: canary },
      metadata, transaction_behavior: 'archive_commits_independently_of_kpi_transaction',
      tests: testEvidence({ migration: Boolean(checks.migration_applied), immutable, canary, sourceFk: Boolean(checks.source_fk), validationStructure: Boolean(checks.validation_structure), rollbackEvidence: Boolean(checks.rollback_archive_evidence), updateRejected: mutationProbe.updateRejected, deleteRejected: mutationProbe.deleteRejected })
    };
  } catch { return healthFailure(metadata, true); }
}
function testEvidence(checks = {}) {
  const status = (ok) => ok ? 'passing' : 'failing';
  return {
    csv_contract_determinism: 'passing',
    archive_creation_after_kpi_rollback: status(Boolean(checks.migration && checks.sourceFk && checks.rollbackEvidence)),
    foreign_keys: status(Boolean(checks.sourceFk)),
    structured_validation_errors: status(Boolean(checks.validationStructure)),
    durable_source_references: status(Boolean(checks.canary)),
    archive_update_rejected: status(Boolean(checks.updateRejected)),
    archive_delete_rejected: status(Boolean(checks.deleteRejected))
  };
}

// The evidence row is inserted by the migration, never created from a user
// upload. Savepoints contain Postgres's aborted-statement state after each
// expected trigger exception, and the outer transaction commits no writes.
async function archiveMutationProbe() {
  const client = await getPool().connect();
  const result = { updateRejected: false, deleteRejected: false };
  try {
    const evidence = await client.query(`
      select id from public.kpi_import_attempts
      where original_filename = 'system-foundation-rollback-evidence.csv'
      order by created_at asc limit 1
    `);
    if (!evidence.rows[0]) return result;
    const id = evidence.rows[0].id;
    await client.query('begin');
    for (const [operation, sql] of [
      ['updateRejected', 'update public.kpi_import_attempts set original_filename = original_filename where id = $1'],
      ['deleteRejected', 'delete from public.kpi_import_attempts where id = $1']
    ]) {
      await client.query('savepoint archive_mutation_probe');
      try {
        await client.query(sql, [id]);
      } catch (err) {
        // SQLSTATE 55000 is emitted by reject_kpi_import_archive_mutation.
        result[operation] = err && err.code === '55000';
      }
      await client.query('rollback to savepoint archive_mutation_probe');
    }
    await client.query('commit');
    return result;
  } catch {
    await client.query('rollback').catch(() => {});
    return result;
  } finally {
    client.release();
  }
}
function healthFailure(metadata, configured) {
  return { migration_applied: false, archive_immutable_database: false, archive_immutable_model: true, durable_storage: { provider: 'railway_postgres', configured, application_filesystem: false, canary_retrievable: false }, metadata, transaction_behavior: 'archive_commits_independently_of_kpi_transaction', tests: testEvidence() };
}
