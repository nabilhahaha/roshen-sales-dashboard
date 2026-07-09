-- =====================================================================
-- Migration 005 — PO↔PI disputes (Option 3 "Dispute")
--
-- Lets the user keep the Purchase Order as the contractual baseline and
-- record the PI differences as OPEN disputes instead of applying a
-- revision. Operations continue on the original PO; disputed PI-only lines
-- never enter delivery / receiving / inventory / matching (those read the
-- PO / latest revision, which a dispute does not change). A dispute stays
-- Open until a revision is applied (auto-resolved) or the user closes it.
-- Applied to Supabase as "po_pi_disputes".
-- =====================================================================
create table if not exists public.po_pi_disputes (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references public.supply_orders(id) on delete cascade,
  pi_id        bigint references public.proforma_invoices(id) on delete set null,
  kind         text not null,                       -- qty_diff | price_diff | missing | additional
  item_code    text,
  roshen_id    text,
  description  text,
  po_qty       numeric,
  po_price     numeric,
  pi_qty       numeric,
  pi_price     numeric,
  qty_delta    numeric,
  value_delta  numeric,
  status       text not null default 'Open'
               check (status = any (array['Open','Resolved'])),
  resolution   text,                                -- Revised | Closed
  reason       text,
  created_by   text,
  created_at   timestamptz not null default now(),
  resolved_by  text,
  resolved_at  timestamptz
);
create index if not exists idx_disputes_order  on public.po_pi_disputes(order_id);
create index if not exists idx_disputes_status on public.po_pi_disputes(status);

alter table public.po_pi_disputes enable row level security;
drop policy if exists po_pi_disputes_all on public.po_pi_disputes;
create policy po_pi_disputes_all on public.po_pi_disputes
  for all to anon, authenticated using (true) with check (true);
