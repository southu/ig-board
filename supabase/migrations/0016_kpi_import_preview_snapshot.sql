-- The preview snapshot is written once with an immutable attempt.  It lets
-- commit reject a preview when a referenced KPI changed without changing its
-- added/updated/unchanged count bucket.
alter table public.kpi_import_attempts
  add column if not exists preview_snapshot text;
