-- Preview classifications are immutable archive metadata, separate from the
-- validation-error array so archive retrieval can reproduce preview counts.
alter table public.kpi_import_attempts
  add column if not exists preview_counts jsonb not null default '{}'::jsonb
  check (jsonb_typeof(preview_counts) = 'object');
