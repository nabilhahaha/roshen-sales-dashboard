-- =====================================================================
-- Migration 016 — universal document attachments (PI / DN / Supplier Invoice)
--
-- Files live in Supabase STORAGE (bucket "supply-attachments"); the database
-- keeps only metadata, so a PI with hundreds of attachments stays fast and
-- screens load metadata lazily (only when the attachments panel is opened).
--
--   * Any document can carry MULTIPLE attachments of any supported type
--     (PDF, Excel/CSV, images) — no PDF-only restriction.
--   * Replacing a file uploads a new REVISION: the old row is marked
--     superseded but never deleted, and the storage object stays — the full
--     attachment history remains permanently linked for audit.
--
-- Applied as "document_attachments".
-- =====================================================================

-- storage bucket (public read for previews/downloads; internal tool)
insert into storage.buckets (id, name, public)
values ('supply-attachments', 'supply-attachments', true)
on conflict (id) do nothing;

-- additive policies scoped to OUR bucket (the dashboard's own storage
-- policies are untouched; permissive policies OR together)
drop policy if exists supply_attachments_read on storage.objects;
create policy supply_attachments_read on storage.objects
  for select to anon, authenticated using (bucket_id = 'supply-attachments');
drop policy if exists supply_attachments_insert on storage.objects;
create policy supply_attachments_insert on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'supply-attachments');
-- no UPDATE / DELETE policies: attachments are immutable and permanent.

-- metadata (the only thing screens query; files are fetched on demand)
create table if not exists public.document_attachments (
  id            bigint generated always as identity primary key,
  doc_type      text not null check (doc_type = any (array['purchase_order','delivery_note','supplier_invoice'])),
  doc_id        bigint not null,
  filename      text not null,
  mime          text,
  byte_size     integer,
  storage_path  text not null,
  revision      integer not null default 1,
  supersedes_id bigint references public.document_attachments(id) on delete set null,
  superseded    boolean not null default false,
  uploaded_by   text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_doc_att_doc on public.document_attachments(doc_type, doc_id);

alter table public.document_attachments enable row level security;
drop policy if exists document_attachments_all on public.document_attachments;
create policy document_attachments_all on public.document_attachments
  for all to anon, authenticated using (true) with check (true);

-- The dashboard's dash_datasets_* policies applied to PUBLIC while calling
-- dash_my_role() (not executable by anon), which errored EVERY anon storage
-- operation. Scoped to authenticated — behaviour-preserving for the dashboard
-- (anon never passed them; it only errored). Applied as
-- "scope_dash_storage_policies_to_authenticated".
alter policy dash_datasets_read  on storage.objects to authenticated;
alter policy dash_datasets_write on storage.objects to authenticated;
