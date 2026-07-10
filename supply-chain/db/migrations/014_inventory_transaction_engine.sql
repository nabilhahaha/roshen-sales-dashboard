-- =====================================================================
-- Migration 014 — Inventory Transaction Engine (the stock ledger)
--
-- inventory_movements becomes a full double-entry-style inventory ledger and
-- the ONLY thing that changes stock. No module updates balances directly:
-- Goods Receipt, Delivery, Returns, Adjustments, Write-offs, Transfers,
-- Production and Reversals all post TRANSACTIONS through the engine service
-- (inventory-transaction.service.js), and balances are always calculated
-- from transactions.
--
-- Ledger row = Transaction: id (Transaction ID), movement_type (Type),
-- reference_module + reference (document), sku_id, batch_id, warehouse,
-- bin_location (future-ready), qty_in / qty_out, uom, unit_cost,
-- running_balance (per SKU+batch+warehouse, stamped at post time —
-- immutable ledger history), created_at (timestamp), created_by (user).
--
-- A BEFORE-INSERT trigger enriches and self-heals every row (sku_id from the
-- batch / item code, qty_in/qty_out ↔ cases_delta kept in sync both ways,
-- running balance computed) so even an insert that bypasses the service
-- cannot corrupt the ledger. Live balances come from views (never stored).
--
-- Additive and backward compatible: cases_delta is preserved and derived,
-- so the fulfillment view, batch_stock and the legacy inventory view keep
-- working unchanged. Applied as "inventory_transaction_engine".
-- =====================================================================

-- ---- 1. ledger columns -------------------------------------------------
alter table public.inventory_movements
  add column if not exists sku_id           bigint references public.sku_master(id) on delete set null,
  add column if not exists reference_module text,            -- goods-receipt | delivery | returns | inventory | production | transfer | stock-count
  add column if not exists bin_location     text,            -- future-ready
  add column if not exists qty_in           numeric,
  add column if not exists qty_out          numeric,
  add column if not exists uom              text default 'CASE',
  add column if not exists running_balance  numeric;
create index if not exists idx_mov_sku on public.inventory_movements(sku_id);

-- ---- 2. full transaction-type set ---------------------------------------
alter table public.inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements
  add constraint inventory_movements_movement_type_check
  check (movement_type = any (array[
    'GR','DELIVERY','RETURN','ADJUST','WRITE_OFF',
    'TRANSFER_IN','TRANSFER_OUT','PRODUCTION','REVERSAL']));

-- ---- 3. enrichment + running-balance trigger ----------------------------
create or replace function public.inv_txn_enrich() returns trigger
language plpgsql as $$
declare prev numeric;
begin
  -- sku spine: from the batch first, else by unique item code
  if new.sku_id is null and new.batch_id is not null then
    select sku_id into new.sku_id from public.batch_master where id = new.batch_id;
  end if;
  if new.sku_id is null and new.item_code is not null then
    select id into new.sku_id from public.sku_master where item_code = new.item_code limit 1;
  end if;
  -- qty_in / qty_out ↔ cases_delta: whichever side is given defines the other
  if new.cases_delta is null and (new.qty_in is not null or new.qty_out is not null) then
    new.cases_delta := coalesce(new.qty_in, 0) - coalesce(new.qty_out, 0);
  end if;
  if new.cases_delta is not null and new.qty_in is null and new.qty_out is null then
    if new.cases_delta >= 0 then new.qty_in := new.cases_delta; new.qty_out := 0;
    else new.qty_in := 0; new.qty_out := -new.cases_delta; end if;
  end if;
  new.qty_in  := coalesce(new.qty_in, 0);
  new.qty_out := coalesce(new.qty_out, 0);
  new.cases_delta := coalesce(new.cases_delta, new.qty_in - new.qty_out);
  new.uom := coalesce(new.uom, 'CASE');
  -- running balance per SKU + batch + warehouse, stamped at post time
  select coalesce(sum(cases_delta), 0) into prev
    from public.inventory_movements
   where coalesce(sku_id, -1) = coalesce(new.sku_id, -1)
     and coalesce(batch_id, -1) = coalesce(new.batch_id, -1)
     and coalesce(warehouse, '') = coalesce(new.warehouse, '');
  new.running_balance := prev + new.cases_delta;
  return new;
end $$;

drop trigger if exists trg_inv_txn_enrich on public.inventory_movements;
create trigger trg_inv_txn_enrich
  before insert on public.inventory_movements
  for each row execute function public.inv_txn_enrich();

-- ---- 4. backfill any existing rows --------------------------------------
update public.inventory_movements m set sku_id = b.sku_id
  from public.batch_master b where m.batch_id = b.id and m.sku_id is null;
update public.inventory_movements m set sku_id = s.id
  from public.sku_master s where m.sku_id is null and m.item_code = s.item_code;
update public.inventory_movements set
  qty_in  = case when cases_delta >= 0 then cases_delta else 0 end,
  qty_out = case when cases_delta < 0 then -cases_delta else 0 end,
  uom     = coalesce(uom, 'CASE')
where qty_in is null or qty_out is null;
with ordered as (
  select id, sum(cases_delta) over (
           partition by coalesce(sku_id,-1), coalesce(batch_id,-1), coalesce(warehouse,'')
           order by created_at, id) as rb
  from public.inventory_movements)
update public.inventory_movements m set running_balance = o.rb
from ordered o where o.id = m.id and m.running_balance is null;

-- ---- 5. balance views (always calculated from transactions) --------------
-- Per SKU + batch + warehouse — the canonical stock balance.
create or replace view public.inventory_balances as
select m.sku_id, m.batch_id, m.warehouse,
       s.item_code, s.roshen_id, s.item_description,
       b.batch_no, b.expiry_date, b.manufacturing_date, b.qc_status, b.hold_status,
       sum(m.qty_in)  as qty_in_total,
       sum(m.qty_out) as qty_out_total,
       sum(m.cases_delta) as cases_on_hand,
       max(m.created_at) as last_movement_at
from public.inventory_movements m
left join public.sku_master  s on s.id = m.sku_id
left join public.batch_master b on b.id = m.batch_id
group by m.sku_id, m.batch_id, m.warehouse, s.item_code, s.roshen_id, s.item_description,
         b.batch_no, b.expiry_date, b.manufacturing_date, b.qc_status, b.hold_status;

-- Per SKU + warehouse rollup.
create or replace view public.inventory_sku_balances as
select m.sku_id, m.warehouse, s.item_code, s.roshen_id, s.item_description,
       sum(m.cases_delta) as cases_on_hand, count(distinct m.batch_id) as batches,
       max(m.created_at) as last_movement_at
from public.inventory_movements m
left join public.sku_master s on s.id = m.sku_id
group by m.sku_id, m.warehouse, s.item_code, s.roshen_id, s.item_description;
