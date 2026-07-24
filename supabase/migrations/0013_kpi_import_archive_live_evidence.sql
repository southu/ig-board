-- Non-sensitive, durable evidence for the public foundation diagnostic.
-- It proves the archive/source relationship survives a rejected KPI operation
-- without exposing a customer CSV, an administrator, or any storage locator.

insert into public.kpi_import_source_files (storage_key, content, byte_size, sha256)
values (
  'kpi-imports/system/foundation-rollback-evidence.txt',
  convert_to('kpi-import-foundation-rollback-evidence-v1', 'utf8'),
  octet_length(convert_to('kpi-import-foundation-rollback-evidence-v1', 'utf8')),
  '20b247ae705809bc3d3b7cb30c54906b60a661744fcbd672988afe592a9bd45b'
)
on conflict (storage_key) do nothing;

insert into public.kpi_import_attempts (
  administrator_id, original_filename, outcome, total_rows, accepted_rows,
  rejected_rows, validation_errors, source_file_id, source_sha256, source_byte_size
)
select
  null,
  'system-foundation-rollback-evidence.csv',
  'rolled_back',
  1,
  0,
  1,
  '[{"row":2,"field":"kpi_name","code":"rejected_transaction"}]'::jsonb,
  s.id,
  s.sha256,
  s.byte_size
from public.kpi_import_source_files s
where s.storage_key = 'kpi-imports/system/foundation-rollback-evidence.txt'
  and not exists (
    select 1 from public.kpi_import_attempts a
    where a.original_filename = 'system-foundation-rollback-evidence.csv'
  );
