-- Migration 006 — Delivery Note enterprise workflow foundation.
-- Additive + backward compatible. Applied as "dn_enterprise_audit_lifecycle".

alter table public.delivery_notes drop constraint if exists delivery_notes_status_check;
alter table public.delivery_notes add constraint delivery_notes_status_check
  check (status = any (array['Draft','Imported','Receiving Review','Received','Cancelled','Reversed']));

alter table public.inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements add constraint inventory_movements_movement_type_check
  check (movement_type = any (array['GR','ADJUST','RETURN','REVERSAL']));

create table if not exists public.dn_audit_log (
  id          bigint generated always as identity primary key,
  dn_id       bigint references public.delivery_notes(id) on delete cascade,
  order_id    bigint references public.supply_orders(id) on delete set null,
  action      text not null,        -- created | edited | cancelled | reversed | status_change | received
  detail      jsonb,
  note        text,
  actor       text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_dn_audit_dn on public.dn_audit_log(dn_id);

alter table public.dn_audit_log enable row level security;
drop policy if exists dn_audit_log_all on public.dn_audit_log;
create policy dn_audit_log_all on public.dn_audit_log
  for all to anon, authenticated using (true) with check (true);
