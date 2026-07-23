-- 0004_memos_upload.sql
-- Founders-only memo upload pipeline: private storage metadata on public.memos,
-- status uploaded → analyzed, server-side extracted_text, board read-only.
--
-- Safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS). The private Storage
-- bucket is created only when the storage schema is present (hosted Supabase).

-- ---------------------------------------------------------------------------
-- Extend memos for file uploads
-- ---------------------------------------------------------------------------
alter table public.memos
  add column if not exists storage_path text,
  add column if not exists meeting_date date,
  add column if not exists status text,
  add column if not exists extracted_text text,
  add column if not exists original_filename text,
  add column if not exists content_type text;

-- Backfill status for any pre-existing prose memos, then enforce the check.
update public.memos
  set status = coalesce(status, 'analyzed')
  where status is null;

alter table public.memos
  alter column status set default 'uploaded';

-- Drop and re-add the status check so re-runs stay idempotent.
alter table public.memos drop constraint if exists memos_status_check;
alter table public.memos
  add constraint memos_status_check
  check (status in ('uploaded', 'analyzed'));

alter table public.memos
  alter column status set not null;

comment on column public.memos.storage_path is
  'Private Storage object path (bucket memos); never a public URL.';
comment on column public.memos.meeting_date is
  'Meeting date the memo covers (founder-supplied on upload).';
comment on column public.memos.status is
  'uploaded after storage write; analyzed after server-side text extraction.';
comment on column public.memos.extracted_text is
  'Plain text extracted server-side (mammoth/pdf); never extracted in the browser.';

create index if not exists memos_meeting_date_idx on public.memos (meeting_date);
create index if not exists memos_status_idx on public.memos (status);
create index if not exists memos_storage_path_idx on public.memos (storage_path);

-- ---------------------------------------------------------------------------
-- RLS: founders upload; board read-only (no board author insert/update/delete)
-- ---------------------------------------------------------------------------
drop policy if exists memos_author_insert on public.memos;
drop policy if exists memos_author_update on public.memos;
drop policy if exists memos_author_delete on public.memos;

-- Keep memos_select (founder + board read) and memos_founder_write (founder all).
-- Re-assert them so a partial migration still ends consistent.
drop policy if exists memos_select on public.memos;
create policy memos_select on public.memos
  for select to authenticated
  using (app.current_user_role() in ('founder', 'board'));

drop policy if exists memos_founder_write on public.memos;
create policy memos_founder_write on public.memos
  for all to authenticated
  using (app.current_user_role() = 'founder')
  with check (app.current_user_role() = 'founder');

-- ---------------------------------------------------------------------------
-- Private Storage bucket `memos` (never public). Access only via signed URLs
-- minted server-side with the service-role key (1h expiry).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.schemata where schema_name = 'storage'
  ) then
    insert into storage.buckets (id, name, public)
    values ('memos', 'memos', false)
    on conflict (id) do update set public = false;

    -- Deny-by-default storage policies: only service_role (bypass) and
    -- authenticated founders may insert; authenticated may read metadata but
    -- objects stay private (downloads go through signed URLs, not public).
    -- Drop any prior policies for a clean re-run.
    begin
      execute 'drop policy if exists memos_storage_select on storage.objects';
      execute 'drop policy if exists memos_storage_insert on storage.objects';
      execute 'drop policy if exists memos_storage_update on storage.objects';
      execute 'drop policy if exists memos_storage_delete on storage.objects';
    exception when others then
      null;
    end;

    -- No SELECT policy that grants direct object reads to authenticated —
    -- clients must use signed URLs. Founder insert for service-path uploads
    -- that go through the user JWT (API prefers service-role, which bypasses).
    execute $p$
      create policy memos_storage_insert on storage.objects
        for insert to authenticated
        with check (
          bucket_id = 'memos'
          and app.current_user_role() = 'founder'
        )
    $p$;
    execute $p$
      create policy memos_storage_delete on storage.objects
        for delete to authenticated
        using (
          bucket_id = 'memos'
          and app.current_user_role() = 'founder'
        )
    $p$;
  end if;
end $$;
