-- =====================================================================
-- Migration 008 — Supplier Invoice enterprise workflow
--
-- Promotes the supplier invoice from a 1:1 DN attachment to a full
-- commercial document flow:
--   * Many invoices per PO and per Delivery Note (partial invoicing).
--   * Document types: tax invoice, credit note, debit note (with a link
--     back to the invoice they adjust).
--   * Replacement chain (an invoice can be superseded by a corrected one)
--     with the original kept for audit rather than deleted.
--   * Line-level reconciliation columns (expected vs invoiced qty / price /
--     tax) so variances are stored, not just recomputed.
--   * ZATCA-ready structured fields (seller/buyer VAT + CR, invoice UUID,
--     invoice counter value, type code, supply date, payment means).
--   * A dispute register mirroring the PO↔PI dispute workflow, and a full
--     audit log mirroring the delivery-note audit log.
--
-- Additive and backward compatible. Applied to Supabase as
-- "supplier_invoice_enterprise".
-- =====================================================================

-- ---- multiple invoices per delivery note ----------------------------
-- The 1:1 DN↔invoice constraint blocked partial invoicing. Drop it and
-- keep the FK plus a plain index. A delivery note can now be covered by
-- several invoices (and credit/debit notes).
alter table public.supplier_invoices drop constraint if exists supplier_invoices_delivery_note_id_key;
create index if not exists idx_si_delivery_note on public.supplier_invoices(delivery_note_id);

-- ---- document type + adjustment / replacement links -----------------
alter table public.supplier_invoices
  add column if not exists doc_type          text not null default 'invoice'
     check (doc_type = any (array['invoice','credit_note','debit_note'])),
  add column if not exists parent_invoice_id bigint references public.supplier_invoices(id) on delete set null,
  add column if not exists superseded_by     bigint references public.supplier_invoices(id) on delete set null,
  add column if not exists adjustment_reason text,
  add column if not exists supply_date       date,
  add column if not exists zatca             jsonb;   -- seller/buyer VAT+CR, uuid, icv, type code, payment means

-- ---- widen the invoice lifecycle statuses ---------------------------
alter table public.supplier_invoices drop constraint if exists supplier_invoices_status_check;
alter table public.supplier_invoices
  add constraint supplier_invoices_status_check
  check (status = any (array['Imported','Matched','Partially Matched','Disputed','Replaced','Cancelled']));

-- A number is unique among ACTIVE documents only, so a Replaced/Cancelled
-- invoice keeps its number for audit while its correction reuses it.
alter table public.supplier_invoices drop constraint if exists supplier_invoices_order_id_invoice_number_key;
create unique index if not exists uq_si_active_number
  on public.supplier_invoices(order_id, invoice_number)
  where status not in ('Replaced','Cancelled');

-- ---- per-line reconciliation (expected vs invoiced) -----------------
alter table public.supplier_invoice_items
  add column if not exists expected_cases      numeric,   -- delivered-but-uninvoiced cases at match time
  add column if not exists expected_case_price numeric,   -- PO case price for the line
  add column if not exists qty_variance        numeric,   -- invoiced - expected (cases)
  add column if not exists price_variance      numeric,   -- invoiced case price - PO case price
  add column if not exists tax_variance        numeric;   -- invoiced VAT - expected VAT (15%)
-- match_status is free text; enterprise values:
--   matched | qty_variance | price_variance | tax_variance | missing | extra | unbound

-- ---- audit log (mirrors dn_audit_log) -------------------------------
create table if not exists public.supplier_invoice_audit_log (
  id          bigint generated always as identity primary key,
  invoice_id  bigint references public.supplier_invoices(id) on delete cascade,
  order_id    bigint references public.supply_orders(id) on delete set null,
  action      text not null,             -- created|edited|matched|disputed|cancelled|replaced|credit_note|debit_note
  detail      jsonb,
  note        text,
  actor       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_si_audit_invoice on public.supplier_invoice_audit_log(invoice_id);

-- ---- dispute register (mirrors po_pi_disputes) ----------------------
create table if not exists public.supplier_invoice_disputes (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references public.supply_orders(id) on delete cascade,
  invoice_id       bigint references public.supplier_invoices(id) on delete cascade,
  delivery_note_id bigint references public.delivery_notes(id) on delete set null,
  kind             text not null,        -- qty_diff | price_diff | tax_diff | missing | extra
  item_code        text,
  roshen_id        text,
  description      text,
  expected_qty     numeric,
  expected_price   numeric,
  invoiced_qty     numeric,
  invoiced_price   numeric,
  qty_delta        numeric,
  value_delta      numeric,
  tax_delta        numeric,
  status           text not null default 'Open'
                   check (status = any (array['Open','Resolved'])),
  resolution       text,                 -- Corrected | CreditNote | DebitNote | Closed
  reason           text,
  created_by       text,
  created_at       timestamptz not null default now(),
  resolved_by      text,
  resolved_at      timestamptz
);
create index if not exists idx_si_disputes_order   on public.supplier_invoice_disputes(order_id);
create index if not exists idx_si_disputes_invoice on public.supplier_invoice_disputes(invoice_id);
create index if not exists idx_si_disputes_status  on public.supplier_invoice_disputes(status);

-- ---- RLS (internal tool: anon + authenticated, same as the rest) ----
alter table public.supplier_invoice_audit_log enable row level security;
drop policy if exists supplier_invoice_audit_log_all on public.supplier_invoice_audit_log;
create policy supplier_invoice_audit_log_all on public.supplier_invoice_audit_log
  for all to anon, authenticated using (true) with check (true);

alter table public.supplier_invoice_disputes enable row level security;
drop policy if exists supplier_invoice_disputes_all on public.supplier_invoice_disputes;
create policy supplier_invoice_disputes_all on public.supplier_invoice_disputes
  for all to anon, authenticated using (true) with check (true);
