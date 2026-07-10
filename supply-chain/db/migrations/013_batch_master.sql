-- =====================================================================
-- Migration 013 — Batch / Lot Master (core ERP entity)
--
-- Every physically received batch becomes a first-class record in
-- batch_master, created automatically by Goods Receipt. Downstream modules
-- (Inventory, QC, FEFO, Returns, Stock Adjustments, recalls) reference the
-- internal Batch ID — not just the SKU.
--
--   * batch_master     — identity, dates, QC / hold state, source-document
--                        traceability (GR / GR batch / DN batch / PO), and the
--                        SKU spine (sku_id).
--   * batch_reservations — reserved quantity (allocation-ready for Sales /
--                        Returns / Production).
--   * batch_audit_log  — every batch state change (QC, hold, adjustment,
--                        release, reversal) is auditable; quantity movements
--                        remain in inventory_movements, which now carries
--                        batch_id.
--   * batch_stock VIEW — live Current / Reserved / Available quantities and
--                        dynamic shelf-life (days + %) — computed, never
--                        stored, so they cannot drift (project rule).
--
-- Backfill: existing goods_receipt_batches become batch_master rows; their
-- GR batches, DN batches and inventory movements are linked by batch_id.
-- Additive and backward compatible. Applied as "batch_master".
-- =====================================================================

create table if not exists public.batch_master (
  id                 bigint generated always as identity primary key,   -- internal Batch ID
  sku_id             bigint not null references public.sku_master(id),
  batch_no           text,
  supplier_batch_no  text,
  manufacturing_date date,
  expiry_date        date,
  received_date      date,
  qc_status          text not null default 'Pending QC'
                     check (qc_status = any (array['Pending QC','Released','Rejected'])),
  hold_status        text not null default 'none'
                     check (hold_status = any (array['none','on_hold'])),
  hold_reason        text,
  released_at        timestamptz,
  supplier           text,
  warehouse          text,
  -- source-document traceability (PO → DN → GR → batch)
  order_id           bigint references public.supply_orders(id)          on delete set null,
  gr_id              bigint references public.goods_receipts(id)         on delete set null,
  gr_batch_id        bigint references public.goods_receipt_batches(id)  on delete set null unique,
  dn_batch_id        bigint references public.delivery_note_batches(id)  on delete set null,
  created_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_batch_master_sku    on public.batch_master(sku_id);
create index if not exists idx_batch_master_expiry on public.batch_master(expiry_date);
create index if not exists idx_batch_master_wh     on public.batch_master(warehouse);

create table if not exists public.batch_reservations (
  id          bigint generated always as identity primary key,
  batch_id    bigint not null references public.batch_master(id) on delete cascade,
  cases       numeric not null,
  reason      text,                     -- e.g. sales order / return / production
  reference   text,
  status      text not null default 'Active'
              check (status = any (array['Active','Released','Consumed'])),
  created_by  text,
  created_at  timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists idx_batch_res_batch on public.batch_reservations(batch_id);

create table if not exists public.batch_audit_log (
  id         bigint generated always as identity primary key,
  batch_id   bigint references public.batch_master(id) on delete cascade,
  action     text not null,   -- created|qc_released|qc_rejected|held|unheld|released|reversed|adjusted|reserved|unreserved
  detail     jsonb,
  note       text,
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists idx_batch_audit_batch on public.batch_audit_log(batch_id);

-- ---- batch spine on documents & the movement ledger -------------------
alter table public.goods_receipt_batches  add column if not exists batch_id bigint references public.batch_master(id) on delete set null;
alter table public.delivery_note_batches  add column if not exists batch_id bigint references public.batch_master(id) on delete set null;
alter table public.inventory_movements    add column if not exists batch_id bigint references public.batch_master(id) on delete set null;
create index if not exists idx_grb_batch on public.goods_receipt_batches(batch_id);
create index if not exists idx_dnb_batch on public.delivery_note_batches(batch_id);
create index if not exists idx_mov_batch on public.inventory_movements(batch_id);

-- ---- backfill from existing goods_receipt_batches ---------------------
insert into public.batch_master
  (sku_id, batch_no, manufacturing_date, expiry_date, received_date, qc_status,
   released_at, supplier, warehouse, order_id, gr_id, gr_batch_id, dn_batch_id, created_by)
select gb.sku_id, gb.batch_no, gb.manufacturing_date, gb.expiry_date, gr.receipt_date,
       case when gb.qc_result in ('Released','Rejected') then gb.qc_result else 'Pending QC' end,
       case when gb.qc_result = 'Released' then gr.released_at end,
       o.supplier, gr.warehouse, gr.order_id, gr.id, gb.id, gb.dn_batch_id, 'backfill-013'
from public.goods_receipt_batches gb
join public.goods_receipts gr on gr.id = gb.gr_id
left join public.supply_orders o on o.id = gr.order_id
where gb.sku_id is not null
on conflict (gr_batch_id) do nothing;

update public.goods_receipt_batches gb set batch_id = b.id
from public.batch_master b where b.gr_batch_id = gb.id and gb.batch_id is null;
update public.delivery_note_batches dnb set batch_id = b.id
from public.batch_master b where b.dn_batch_id = dnb.id and dnb.batch_id is null;
update public.inventory_movements m set batch_id = b.id
from public.batch_master b where b.gr_batch_id = m.gr_batch_id and m.batch_id is null;

-- ---- live stock + shelf-life view -------------------------------------
create or replace view public.batch_stock as
select b.*,
       s.item_code, s.roshen_id, s.item_description,
       s.shelf_life_value, s.shelf_life_unit, s.min_remaining_shelf_life_pct,
       coalesce(m.qty, 0)                       as current_cases,
       coalesce(r.qty, 0)                       as reserved_cases,
       coalesce(m.qty, 0) - coalesce(r.qty, 0)  as available_cases,
       (b.expiry_date - current_date)           as remaining_days,
       case when b.expiry_date is not null and b.manufacturing_date is not null
                 and b.expiry_date > b.manufacturing_date
            then round(100.0 * greatest(b.expiry_date - current_date, 0)
                       / (b.expiry_date - b.manufacturing_date), 1) end as remaining_pct
from public.batch_master b
join public.sku_master s on s.id = b.sku_id
left join (select batch_id, sum(cases_delta) qty from public.inventory_movements
            where batch_id is not null group by batch_id) m on m.batch_id = b.id
left join (select batch_id, sum(cases) qty from public.batch_reservations
            where status = 'Active' group by batch_id) r on r.batch_id = b.id;

-- ---- RLS (internal tool pattern) ---------------------------------------
alter table public.batch_master enable row level security;
drop policy if exists batch_master_all on public.batch_master;
create policy batch_master_all on public.batch_master for all to anon, authenticated using (true) with check (true);
alter table public.batch_reservations enable row level security;
drop policy if exists batch_reservations_all on public.batch_reservations;
create policy batch_reservations_all on public.batch_reservations for all to anon, authenticated using (true) with check (true);
alter table public.batch_audit_log enable row level security;
drop policy if exists batch_audit_log_all on public.batch_audit_log;
create policy batch_audit_log_all on public.batch_audit_log for all to anon, authenticated using (true) with check (true);
