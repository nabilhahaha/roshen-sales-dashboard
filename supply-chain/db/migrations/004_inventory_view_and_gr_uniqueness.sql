-- =====================================================================
-- Migration 004 — Movement-based inventory + goods-receipt uniqueness
--
-- Stabilization: make `inventory` a VIEW over inventory_movements so the
-- on-hand balance is always derived from the movement ledger (single
-- source of truth). This removes the read-then-write path that could
-- create duplicate rows for batches with a null batch_no / expiry_date /
-- warehouse and was not concurrency-safe.
--
-- Also enforce exactly one goods receipt per delivery note, so creation is
-- idempotent and double-click / concurrent creation raises 23505 instead
-- of producing a duplicate receipt (which would double-post inventory).
-- Applied to Supabase as "inventory_view_and_gr_uniqueness".
-- =====================================================================

drop table if exists public.inventory cascade;
create view public.inventory as
select
  min(id)                    as id,
  roshen_id,
  max(item_code)             as item_code,
  max(description)           as description,
  batch_no,
  max(manufacturing_date)    as manufacturing_date,
  expiry_date,
  warehouse,
  sum(cases_delta)           as cases_on_hand,
  max(created_at)            as updated_at
from public.inventory_movements
group by roshen_id, batch_no, expiry_date, warehouse;
grant select on public.inventory to anon, authenticated;

alter table public.goods_receipts drop constraint if exists goods_receipts_dn_unique;
alter table public.goods_receipts add constraint goods_receipts_dn_unique unique (delivery_note_id);
