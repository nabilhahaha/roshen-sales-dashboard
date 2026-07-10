-- 021 — Manual "Close Purchase Order" + PO-level audit log.
--
-- A purchase order can be closed by the business before it is fully
-- delivered (supplier cancelled, replaced by a new PO, …). Closing is a
-- business action, never a delete: the order keeps all its history, the
-- remaining quantities become Cancelled, and the close carries a mandatory
-- reason, optional comments, the closer and the timestamp — plus an optional
-- link to the replacement purchase order.
alter table public.supply_orders
  add column if not exists close_reason text,
  add column if not exists close_comments text,
  add column if not exists closed_by text,
  add column if not exists closed_at timestamptz,
  add column if not exists replaced_by_order_id bigint references public.supply_orders(id) on delete set null;

create index if not exists idx_supply_orders_replaced_by on public.supply_orders(replaced_by_order_id)
  where replaced_by_order_id is not null;

-- PO-level audit trail (approve / close / status changes …) — mirrors the
-- dn_audit_log pattern used by the other documents.
create table if not exists public.po_audit_log (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.supply_orders(id) on delete cascade,
  action text not null,
  actor text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_po_audit_order on public.po_audit_log(order_id, created_at);

alter table public.po_audit_log enable row level security;
drop policy if exists po_audit_log_all on public.po_audit_log;
create policy po_audit_log_all on public.po_audit_log
  for all to anon, authenticated using (true) with check (true);
