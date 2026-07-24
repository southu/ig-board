-- Immutable archival foundation for KPI CSV import attempts.  Source bytes live
-- in PostgreSQL (Railway's persistent volume/service), never on app disk.

create table if not exists public.kpi_import_source_files (
  id uuid primary key default gen_random_uuid(),
  storage_key text not null unique,
  content bytea not null,
  content_type text not null default 'text/csv',
  byte_size bigint not null check (byte_size >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

create table if not exists public.kpi_import_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  administrator_id uuid references public.users(id) on delete set null,
  original_filename text not null,
  outcome text not null check (outcome in ('accepted', 'rejected', 'partial', 'rolled_back')),
  total_rows integer not null check (total_rows >= 0),
  accepted_rows integer not null check (accepted_rows >= 0),
  rejected_rows integer not null check (rejected_rows >= 0),
  validation_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(validation_errors) = 'array'),
  source_file_id uuid not null references public.kpi_import_source_files(id) on delete restrict,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_byte_size bigint not null check (source_byte_size >= 0),
  constraint kpi_import_attempt_counts check (accepted_rows + rejected_rows <= total_rows)
);

create index if not exists kpi_import_attempts_created_at_idx on public.kpi_import_attempts (created_at desc);
create index if not exists kpi_import_attempts_administrator_id_idx on public.kpi_import_attempts (administrator_id);

-- A non-sensitive fixed object proves that the durable store is writable and
-- remains addressable after a process/deployment restart. It contains no CSV
-- data and is deliberately not linked to an import attempt.
insert into public.kpi_import_source_files (storage_key, content, byte_size, sha256)
values (
  'kpi-imports/system/durable-canary.txt',
  convert_to('kpi-import-durable-storage-canary-v1', 'utf8'),
  octet_length(convert_to('kpi-import-durable-storage-canary-v1', 'utf8')),
  '90969829b1ff88bb50174bc5936355e3aa4cdc1916a1953107a7f75ff3b0d2b8'
)
on conflict (storage_key) do nothing;

create or replace function public.reject_kpi_import_archive_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'kpi import archives are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists kpi_import_attempts_no_update on public.kpi_import_attempts;
create trigger kpi_import_attempts_no_update before update on public.kpi_import_attempts
  for each row execute function public.reject_kpi_import_archive_mutation();
drop trigger if exists kpi_import_attempts_no_delete on public.kpi_import_attempts;
create trigger kpi_import_attempts_no_delete before delete on public.kpi_import_attempts
  for each row execute function public.reject_kpi_import_archive_mutation();
drop trigger if exists kpi_import_source_files_no_update on public.kpi_import_source_files;
create trigger kpi_import_source_files_no_update before update on public.kpi_import_source_files
  for each row execute function public.reject_kpi_import_archive_mutation();
drop trigger if exists kpi_import_source_files_no_delete on public.kpi_import_source_files;
create trigger kpi_import_source_files_no_delete before delete on public.kpi_import_source_files
  for each row execute function public.reject_kpi_import_archive_mutation();

comment on table public.kpi_import_attempts is 'Append-only KPI CSV import attempt archive.';
comment on table public.kpi_import_source_files is 'Private durable original KPI CSV objects; never public URLs.';
