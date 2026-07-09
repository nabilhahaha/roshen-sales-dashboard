-- =====================================================================
-- Migration 002 — Delivery Note / Partial-Fulfillment / Batch / Shelf-Life
-- Applied to Supabase as "dn_partial_fulfillment_batches_shelf_life".
-- See db/DESIGN.md for the narrative. Idempotent guards throughout.
-- =====================================================================

-- Drop any earlier line-level DN tables first (they were empty). This makes the
-- migration reproduce the batch-based schema even where the tables pre-existed.
drop view  if exists public.po_line_fulfillment cascade;
drop table if exists public.inventory_movements cascade;
drop table if exists public.inventory cascade;
drop table if exists public.shelf_life_exceptions cascade;
drop table if exists public.goods_receipt_batches cascade;
drop table if exists public.goods_receipt_items cascade;
drop table if exists public.goods_receipts cascade;
drop table if exists public.supplier_invoice_items cascade;
drop table if exists public.supplier_invoices cascade;
drop table if exists public.delivery_note_batches cascade;
drop table if exists public.delivery_note_items cascade;
drop table if exists public.delivery_notes cascade;

-- ---- SKU MASTER: shelf-life master data (maintained manually) --------
alter table public.sku_master
  add column if not exists shelf_life_value numeric,
  add column if not exists shelf_life_unit  text
     check (shelf_life_unit is null or shelf_life_unit = any (array['Days','Months','Years'])),
  add column if not exists min_remaining_shelf_life_pct numeric;

-- ---- PO status: operational + financial completion, no auto-close ----
alter table public.supply_orders drop constraint if exists supply_orders_status_check;
alter table public.supply_orders add constraint supply_orders_status_check
  check (status = any (array[
    'Draft','Approved','PI Imported','Revision Required','Revision Applied',
    'PI Approved','Ready for Shipment',
    'Partially Delivered','Fully Delivered',
    'Partially Received','Fully Received',
    'Invoice Matched','Financially Closed',
    'Closed'
  ]));

-- =====================================================================
-- DELIVERY NOTES (many per order)
-- =====================================================================
create table if not exists public.delivery_notes (
  id             bigint generated always as identity primary key,
  order_id       bigint not null references public.supply_orders(id) on delete cascade,
  dn_number      text not null,
  dn_date        date,
  supplier       text,
  po_reference   text,
  currency       text default 'SAR',
  total_cartons  numeric,
  notes          text,
  status         text not null default 'Imported'
                 check (status = any (array['Imported','Receiving Review','Received','Cancelled'])),
  source_filename text,
  header_extra   jsonb,
  created_by     text,
  imported_at    timestamptz not null default now(),
  received_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (order_id, dn_number)
);
create index if not exists idx_delivery_notes_order  on public.delivery_notes(order_id);
create index if not exists idx_delivery_notes_status on public.delivery_notes(status);

-- DN LINE = one document line per SKU (no batch/expiry here)
create table if not exists public.delivery_note_items (
  id           bigint generated always as identity primary key,
  dn_id        bigint not null references public.delivery_notes(id) on delete cascade,
  po_item_id   bigint references public.supply_order_items(id) on delete set null,
  line_no      integer,
  item_code    text,
  roshen_id    text,
  description  text,
  uom          text,
  barcode      text,
  match_status text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_dn_items_dn     on public.delivery_note_items(dn_id);
create index if not exists idx_dn_items_roshen on public.delivery_note_items(roshen_id);

-- DN BATCH = physical batch (1..N per line). Shelf-life computed from dates.
create table if not exists public.delivery_note_batches (
  id                 bigint generated always as identity primary key,
  dn_item_id         bigint not null references public.delivery_note_items(id) on delete cascade,
  batch_no           text,
  manufacturing_date date,
  expiry_date        date,
  cases              numeric not null default 0,
  boxes              numeric,
  pieces             numeric,
  qc_status          text not null default 'Pending QC'
                     check (qc_status = any (array['Pending QC','Released','Rejected'])),
  shelf_life_flag    text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_dn_batches_item on public.delivery_note_batches(dn_item_id);

-- =====================================================================
-- SUPPLIER INVOICES (many per order, 1:1 with a delivery note)
-- =====================================================================
create table if not exists public.supplier_invoices (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references public.supply_orders(id) on delete cascade,
  delivery_note_id bigint unique references public.delivery_notes(id) on delete set null,
  invoice_number   text not null,
  invoice_date     date,
  supplier         text,
  currency         text default 'SAR',
  total_taxable    numeric,
  total_vat        numeric,
  grand_total      numeric,
  status           text not null default 'Imported'
                   check (status = any (array['Imported','Matched','Disputed','Cancelled'])),
  match_summary    jsonb,
  source_filename  text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (order_id, invoice_number)
);
create index if not exists idx_supplier_invoices_order on public.supplier_invoices(order_id);

create table if not exists public.supplier_invoice_items (
  id             bigint generated always as identity primary key,
  invoice_id     bigint not null references public.supplier_invoices(id) on delete cascade,
  dn_item_id     bigint references public.delivery_note_items(id) on delete set null,
  po_item_id     bigint references public.supply_order_items(id)  on delete set null,
  line_no        integer,
  item_code      text,
  roshen_id      text,
  description    text,
  uom            text,
  invoiced_cases numeric not null default 0,
  case_price     numeric,
  taxable_amount numeric,
  vat_percent    numeric,
  vat_amount     numeric,
  line_total     numeric,
  match_status   text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_si_items_invoice on public.supplier_invoice_items(invoice_id);

-- =====================================================================
-- GOODS RECEIPTS (header per DN) + batch-level receiving with QC
-- Inventory increases ONLY for batches with qc_result = 'Released'.
-- =====================================================================
create table if not exists public.goods_receipts (
  id               bigint generated always as identity primary key,
  order_id         bigint not null references public.supply_orders(id) on delete cascade,
  delivery_note_id bigint not null references public.delivery_notes(id) on delete cascade,
  grn_number       text,
  receipt_date     date default current_date,
  warehouse        text,
  status           text not null default 'Pending QC'
                   check (status = any (array['Pending QC','Partially Released','Released','Rejected','Cancelled'])),
  notes            text,
  created_by       text,
  released_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_goods_receipts_order on public.goods_receipts(order_id);
create index if not exists idx_goods_receipts_dn    on public.goods_receipts(delivery_note_id);

-- GR BATCH = warehouse receives each physical batch individually
create table if not exists public.goods_receipt_batches (
  id             bigint generated always as identity primary key,
  gr_id          bigint not null references public.goods_receipts(id) on delete cascade,
  dn_batch_id    bigint references public.delivery_note_batches(id) on delete set null,
  dn_item_id     bigint references public.delivery_note_items(id)   on delete set null,
  si_item_id     bigint references public.supplier_invoice_items(id) on delete set null,
  po_item_id     bigint references public.supply_order_items(id)    on delete set null,
  line_no        integer,
  item_code      text,
  roshen_id      text,
  description    text,
  uom            text,
  batch_no       text,
  manufacturing_date date,
  expiry_date    date,
  delivered_cases numeric not null default 0,
  received_cases  numeric not null default 0,
  damaged_cases   numeric not null default 0,
  short_cases     numeric not null default 0,
  rejected_cases  numeric not null default 0,
  qc_result      text not null default 'Pending QC'
                 check (qc_result = any (array['Pending QC','Released','Rejected'])),
  qc_note        text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_gr_batches_gr on public.goods_receipt_batches(gr_id);

-- =====================================================================
-- SHELF-LIFE RECEIVING EXCEPTIONS (audit, batch-level)
-- =====================================================================
create table if not exists public.shelf_life_exceptions (
  id            bigint generated always as identity primary key,
  order_id      bigint references public.supply_orders(id)        on delete set null,
  dn_id         bigint references public.delivery_notes(id)       on delete set null,
  dn_item_id    bigint references public.delivery_note_items(id)  on delete set null,
  dn_batch_id   bigint references public.delivery_note_batches(id) on delete set null,
  item_code     text,
  roshen_id     text,
  batch_no      text,
  expiry_date   date,
  required_pct  numeric,
  remaining_pct numeric,
  decision      text not null check (decision = any (array['Accept Exception','Reject Item'])),
  reason        text,
  decided_by    text,
  decided_at    timestamptz not null default now()
);
create index if not exists idx_shelf_exc_order on public.shelf_life_exceptions(order_id);

-- =====================================================================
-- INVENTORY (batch-level, movement-based)
-- =====================================================================
create table if not exists public.inventory_movements (
  id            bigint generated always as identity primary key,
  order_id      bigint references public.supply_orders(id)          on delete set null,
  gr_id         bigint references public.goods_receipts(id)         on delete set null,
  gr_batch_id   bigint references public.goods_receipt_batches(id)  on delete set null,
  dn_batch_id   bigint references public.delivery_note_batches(id)  on delete set null,
  dn_id         bigint references public.delivery_notes(id)         on delete set null,
  item_code     text,
  roshen_id     text,
  description   text,
  batch_no      text,
  manufacturing_date date,
  expiry_date   date,
  warehouse     text,
  movement_type text not null default 'GR' check (movement_type = any (array['GR','ADJUST','RETURN'])),
  cases_delta   numeric not null,
  unit_cost     numeric,
  reference     text,
  created_by    text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_inv_moves_order  on public.inventory_movements(order_id);
create index if not exists idx_inv_moves_roshen on public.inventory_movements(roshen_id);

create table if not exists public.inventory (
  id            bigint generated always as identity primary key,
  item_code     text,
  roshen_id     text,
  description   text,
  batch_no      text,
  manufacturing_date date,
  expiry_date   date,
  warehouse     text,
  cases_on_hand numeric not null default 0,
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (roshen_id, batch_no, expiry_date, warehouse)
);
create index if not exists idx_inventory_roshen on public.inventory(roshen_id);
create index if not exists idx_inventory_expiry on public.inventory(expiry_date);

-- =====================================================================
-- PER-PO-LINE FULFILLMENT LEDGER (view — never stored)
-- =====================================================================
create view public.po_line_fulfillment as
with effective as (
  select o.id as order_id,
         coalesce(nullif(x.roshen_id,''), x.item_code) as line_key,
         x.item_code, x.roshen_id, x.item_description as description,
         x.ordered_cases, x.price_case
  from public.supply_orders o
  cross join lateral (
    select (select r.id from public.supply_order_revisions r
            where r.order_id = o.id order by r.revision_no desc limit 1) as rev_id
  ) lr
  join lateral (
    select item_code, roshen_id, item_description, ordered_cases, price_case
    from public.supply_order_revision_items ri where ri.revision_id = lr.rev_id
    union all
    select item_code, roshen_id, item_description, ordered_cases, price_case
    from public.supply_order_items oi where oi.order_id = o.id and lr.rev_id is null
  ) x on true
),
eff as (
  select order_id, line_key,
         max(item_code) as item_code, max(roshen_id) as roshen_id,
         max(description) as description, max(price_case) as price_case,
         sum(ordered_cases) as ordered_cases
  from effective where line_key is not null
  group by order_id, line_key
),
delivered as (
  select dn.order_id, coalesce(nullif(di.roshen_id,''), di.item_code) as line_key,
         sum(b.cases) as delivered_cases
  from public.delivery_notes dn
  join public.delivery_note_items di on di.dn_id = dn.id
  join public.delivery_note_batches b on b.dn_item_id = di.id
  where dn.status <> 'Cancelled'
  group by dn.order_id, coalesce(nullif(di.roshen_id,''), di.item_code)
),
invoiced as (
  select si.order_id, coalesce(nullif(sii.roshen_id,''), sii.item_code) as line_key,
         sum(sii.invoiced_cases) as invoiced_cases
  from public.supplier_invoices si
  join public.supplier_invoice_items sii on sii.invoice_id = si.id
  where si.status <> 'Cancelled'
  group by si.order_id, coalesce(nullif(sii.roshen_id,''), sii.item_code)
),
received as (
  select gr.order_id, coalesce(nullif(gb.roshen_id,''), gb.item_code) as line_key,
         sum(gb.received_cases) as received_cases
  from public.goods_receipts gr
  join public.goods_receipt_batches gb on gb.gr_id = gr.id
  where gb.qc_result = 'Released'
  group by gr.order_id, coalesce(nullif(gb.roshen_id,''), gb.item_code)
)
select e.order_id, e.line_key, e.item_code, e.roshen_id, e.description, e.price_case,
       e.ordered_cases,
       coalesce(d.delivered_cases,0) as delivered_cases,
       coalesce(i.invoiced_cases,0)  as invoiced_cases,
       coalesce(r.received_cases,0)  as received_cases,
       (e.ordered_cases              - coalesce(d.delivered_cases,0)) as open_delivery,
       (coalesce(d.delivered_cases,0) - coalesce(i.invoiced_cases,0)) as open_invoice,
       (coalesce(d.delivered_cases,0) - coalesce(r.received_cases,0)) as open_receipt
from eff e
left join delivered d on d.order_id = e.order_id and d.line_key = e.line_key
left join invoiced  i on i.order_id = e.order_id and i.line_key = e.line_key
left join received  r on r.order_id = e.order_id and r.line_key = e.line_key;

grant select on public.po_line_fulfillment to anon, authenticated;

-- =====================================================================
-- OPERATIONAL status recompute (delivery/receipt only — never financial)
-- =====================================================================
create or replace function public.recompute_order_fulfillment(p_order_id bigint)
returns void language plpgsql as $$
declare
  v_delivered numeric; v_received numeric;
  v_open_delivery numeric; v_open_receipt numeric; v_status text; v_new text;
begin
  select coalesce(sum(delivered_cases),0), coalesce(sum(received_cases),0),
         coalesce(sum(greatest(open_delivery,0)),0), coalesce(sum(greatest(open_receipt,0)),0)
    into v_delivered, v_received, v_open_delivery, v_open_receipt
  from public.po_line_fulfillment where order_id = p_order_id;

  select status into v_status from public.supply_orders where id = p_order_id;

  if v_status not in ('PI Approved','Ready for Shipment',
                      'Partially Delivered','Fully Delivered',
                      'Partially Received','Fully Received') then
    return;
  end if;

  v_new := v_status;
  if v_received > 0 and v_open_receipt <= 0.0001 and v_open_delivery <= 0.0001 then
    v_new := 'Fully Received';
  elsif v_received > 0 then
    v_new := 'Partially Received';
  elsif v_delivered > 0 and v_open_delivery <= 0.0001 then
    v_new := 'Fully Delivered';
  elsif v_delivered > 0 then
    v_new := 'Partially Delivered';
  end if;

  if v_new <> v_status then
    update public.supply_orders set status = v_new, updated_at = now() where id = p_order_id;
  end if;
end $$;

create or replace function public.trg_recompute_dn_batch() returns trigger language plpgsql as $$
declare v_order bigint;
begin
  select dn.order_id into v_order
  from public.delivery_note_batches b
  join public.delivery_note_items di on di.id = b.dn_item_id
  join public.delivery_notes dn on dn.id = di.dn_id
  where b.id = coalesce(new.id, old.id);
  if v_order is not null then perform public.recompute_order_fulfillment(v_order); end if;
  return null;
end $$;

create or replace function public.trg_recompute_gr_batch() returns trigger language plpgsql as $$
declare v_order bigint;
begin
  select gr.order_id into v_order from public.goods_receipts gr
  where gr.id = coalesce(new.gr_id, old.gr_id);
  if v_order is not null then perform public.recompute_order_fulfillment(v_order); end if;
  return null;
end $$;

drop trigger if exists dn_batch_recompute on public.delivery_note_batches;
create trigger dn_batch_recompute after insert or update or delete on public.delivery_note_batches
  for each row execute function public.trg_recompute_dn_batch();

drop trigger if exists gr_batch_recompute on public.goods_receipt_batches;
create trigger gr_batch_recompute after insert or update or delete on public.goods_receipt_batches
  for each row execute function public.trg_recompute_gr_batch();

-- =====================================================================
-- RLS — internal dev tool: permissive for anon + authenticated
-- =====================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'delivery_notes','delivery_note_items','delivery_note_batches',
    'supplier_invoices','supplier_invoice_items',
    'goods_receipts','goods_receipt_batches','shelf_life_exceptions',
    'inventory','inventory_movements'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t||'_all', t);
    execute format(
      'create policy %I on public.%I for all to anon, authenticated using (true) with check (true)',
      t||'_all', t);
  end loop;
end $$;
