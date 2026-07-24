-- Keep the known authenticated administrator address with the immutable
-- attempt. This is an attribution fallback when the identity has not yet been
-- mirrored into public.users; it is returned only from administrator routes.
alter table public.kpi_import_attempts
  add column if not exists administrator_email text;

