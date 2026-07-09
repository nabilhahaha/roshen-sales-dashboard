-- =====================================================================
-- Migration 003 — Supplier invoice is UPLOADED (PDF), not created
--
-- The supplier invoice is the supplier's own received document. It is
-- uploaded, its data extracted, stored with the original file for audit,
-- and validated against the Delivery Note. Applied to Supabase as
-- "supplier_invoice_document_upload" + "supplier_invoice_documents_table".
-- =====================================================================

-- Extra fields captured from the uploaded document + validation outcome.
alter table public.supplier_invoices
  add column if not exists buyer          text,
  add column if not exists source_type    text default 'pdf'
     check (source_type is null or source_type = any (array['pdf','xml','manual'])),
  add column if not exists document_path   text,   -- 'db:supplier_invoice_documents' when a file is attached
  add column if not exists document_name   text,   -- original filename
  add column if not exists dn_reference     text,   -- DN ref printed on the invoice
  add column if not exists extracted        jsonb,  -- raw extracted header/lines (audit)
  add column if not exists validation_summary jsonb;-- DN↔invoice comparison result

-- Original document (base64) stored in-module rather than storage.objects,
-- whose Sales-Dashboard policies reference a function anon cannot evaluate.
create table if not exists public.supplier_invoice_documents (
  id          bigint generated always as identity primary key,
  invoice_id  bigint references public.supplier_invoices(id) on delete cascade,
  order_id    bigint references public.supply_orders(id) on delete set null,
  filename    text,
  mime        text default 'application/pdf',
  byte_size   integer,
  data        text,          -- base64-encoded original file
  created_by  text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_si_docs_invoice on public.supplier_invoice_documents(invoice_id);

alter table public.supplier_invoice_documents enable row level security;
drop policy if exists supplier_invoice_documents_all on public.supplier_invoice_documents;
create policy supplier_invoice_documents_all on public.supplier_invoice_documents
  for all to anon, authenticated using (true) with check (true);
