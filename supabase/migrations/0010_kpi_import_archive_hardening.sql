-- Keep the archive migration independently verifiable on every Railway deploy.
-- 0009 creates the tables/triggers; this migration records a durable canary
-- repair and makes its expected integrity data explicit for health probes.

insert into public.kpi_import_source_files (storage_key, content, byte_size, sha256)
values (
  'kpi-imports/system/durable-canary.txt',
  convert_to('kpi-import-durable-storage-canary-v1', 'utf8'),
  octet_length(convert_to('kpi-import-durable-storage-canary-v1', 'utf8')),
  '90969829b1ff88bb50174bc5936355e3aa4cdc1916a1953107a7f75ff3b0d2b8'
)
on conflict (storage_key) do nothing;

comment on table public.kpi_import_source_files is
  'Private durable PostgreSQL object archive for original KPI import CSVs.';
