-- =====================================================================
-- Migration 011 — SKU Master as the ERP-wide single source of truth
--
--  1. Classification & identity attributes on sku_master (barcode, brand,
--     category, sub-category, product family, variant/flavor).
--  2. Integrity: item_code UNIQUE (hard); Roshen ID uniqueness is a soft,
--     service-level rule (one legacy duplicate exists and duplicates may be
--     explicitly allowed).
--  3. Versioning: sku_master.version + a trigger that, on every real change,
--     bumps the version and stores the full BEFORE-image in sku_versions —
--     an immutable version history no application path can skip.
--  4. Future-proofing tables: multiple barcodes, multiple suppliers with
--     supplier-specific item codes, packaging variants, images/attachments.
--  5. Document → SKU spine: nullable sku_id on every document line table
--     (PO / DN / SI / GR), backfilled by item code (unique) then by
--     unambiguous Roshen ID. Documents keep their own copied descriptive
--     fields (code, description, price at transaction time), so history
--     always shows the values that existed when the transaction was created
--     — a later SKU edit never rewrites a historical document.
--
-- Additive and backward compatible. Applied to Supabase as
-- "sku_master_source_of_truth".
-- =====================================================================

-- ---- 1. classification / identity attributes ------------------------
alter table public.sku_master
  add column if not exists barcode         text,      -- primary barcode (more in sku_barcodes)
  add column if not exists brand           text,
  add column if not exists category        text,
  add column if not exists sub_category    text,
  add column if not exists product_family  text,
  add column if not exists variant_flavor  text,
  add column if not exists version         integer not null default 1;

-- ---- 2. hard uniqueness on Item Code --------------------------------
create unique index if not exists uq_sku_item_code on public.sku_master(item_code);

-- ---- 3. immutable version history ------------------------------------
create table if not exists public.sku_versions (
  id         bigint generated always as identity primary key,
  sku_id     bigint not null references public.sku_master(id) on delete cascade,
  version    integer not null,
  snapshot   jsonb not null,          -- full row as it was BEFORE the change
  created_at timestamptz not null default now(),
  unique (sku_id, version)
);
create index if not exists idx_sku_versions_sku on public.sku_versions(sku_id);

create or replace function public.sku_version_bump() returns trigger
language plpgsql as $$
begin
  insert into public.sku_versions(sku_id, version, snapshot)
  values (old.id, coalesce(old.version, 1), to_jsonb(old))
  on conflict (sku_id, version) do nothing;
  new.version := coalesce(old.version, 1) + 1;
  return new;
end $$;

drop trigger if exists trg_sku_version on public.sku_master;
create trigger trg_sku_version
  before update on public.sku_master
  for each row when (old.* is distinct from new.*)
  execute function public.sku_version_bump();

-- ---- 4. future-proofing satellites -----------------------------------
create table if not exists public.sku_barcodes (
  id         bigint generated always as identity primary key,
  sku_id     bigint not null references public.sku_master(id) on delete cascade,
  barcode    text not null,
  kind       text default 'EAN13',          -- EAN13 | EAN14 | UPC | internal | other
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  unique (barcode)
);
create index if not exists idx_sku_barcodes_sku on public.sku_barcodes(sku_id);

create table if not exists public.sku_suppliers (
  id                 bigint generated always as identity primary key,
  sku_id             bigint not null references public.sku_master(id) on delete cascade,
  supplier           text not null,
  supplier_item_code text,                  -- the supplier's own code for this SKU
  is_default         boolean not null default false,
  lead_time_days     integer,
  notes              text,
  created_at         timestamptz not null default now(),
  unique (sku_id, supplier)
);
create index if not exists idx_sku_suppliers_sku on public.sku_suppliers(sku_id);

create table if not exists public.sku_packaging_variants (
  id               bigint generated always as identity primary key,
  sku_id           bigint not null references public.sku_master(id) on delete cascade,
  variant_name     text not null,           -- e.g. "Family Pack", "Display Box"
  unit_weight_g    numeric,
  units_per_carton integer,
  barcode          text,
  status           text not null default 'active',
  created_at       timestamptz not null default now(),
  unique (sku_id, variant_name)
);

create table if not exists public.sku_attachments (
  id         bigint generated always as identity primary key,
  sku_id     bigint not null references public.sku_master(id) on delete cascade,
  kind       text not null default 'image'  -- image | spec_pdf | other
             check (kind = any (array['image','spec_pdf','other'])),
  filename   text,
  mime       text,
  byte_size  integer,
  data       text,                          -- base64 (same in-module pattern as invoice documents)
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sku_attachments_sku on public.sku_attachments(sku_id);

-- ---- 5. document → SKU spine (nullable FK + backfill) -----------------
alter table public.supply_order_items      add column if not exists sku_id bigint references public.sku_master(id) on delete set null;
alter table public.delivery_note_items     add column if not exists sku_id bigint references public.sku_master(id) on delete set null;
alter table public.supplier_invoice_items  add column if not exists sku_id bigint references public.sku_master(id) on delete set null;
alter table public.goods_receipt_batches   add column if not exists sku_id bigint references public.sku_master(id) on delete set null;
create index if not exists idx_soi_sku on public.supply_order_items(sku_id);
create index if not exists idx_dni_sku on public.delivery_note_items(sku_id);
create index if not exists idx_sii_sku on public.supplier_invoice_items(sku_id);
create index if not exists idx_grb_sku on public.goods_receipt_batches(sku_id);

-- Backfill: item_code first (unique), then Roshen ID where it maps to exactly
-- one SKU (the legacy duplicate Roshen ID stays null for manual resolution).
do $$
declare t text;
begin
  foreach t in array array['supply_order_items','delivery_note_items','supplier_invoice_items','goods_receipt_batches'] loop
    execute format('update public.%I d set sku_id = s.id from public.sku_master s
      where d.sku_id is null and d.item_code is not null and d.item_code = s.item_code', t);
    execute format('update public.%I d set sku_id = s.id from public.sku_master s
      where d.sku_id is null and d.roshen_id is not null
        and regexp_replace(d.roshen_id, ''^0+(?=\d)'', '''') = regexp_replace(s.roshen_id, ''^0+(?=\d)'', '''')
        and (select count(*) from public.sku_master s2
              where regexp_replace(s2.roshen_id, ''^0+(?=\d)'', '''') = regexp_replace(s.roshen_id, ''^0+(?=\d)'', '''')) = 1', t);
  end loop;
end $$;

-- ---- RLS (internal tool pattern) --------------------------------------
alter table public.sku_versions enable row level security;
drop policy if exists sku_versions_all on public.sku_versions;
create policy sku_versions_all on public.sku_versions for all to anon, authenticated using (true) with check (true);
alter table public.sku_barcodes enable row level security;
drop policy if exists sku_barcodes_all on public.sku_barcodes;
create policy sku_barcodes_all on public.sku_barcodes for all to anon, authenticated using (true) with check (true);
alter table public.sku_suppliers enable row level security;
drop policy if exists sku_suppliers_all on public.sku_suppliers;
create policy sku_suppliers_all on public.sku_suppliers for all to anon, authenticated using (true) with check (true);
alter table public.sku_packaging_variants enable row level security;
drop policy if exists sku_packaging_variants_all on public.sku_packaging_variants;
create policy sku_packaging_variants_all on public.sku_packaging_variants for all to anon, authenticated using (true) with check (true);
alter table public.sku_attachments enable row level security;
drop policy if exists sku_attachments_all on public.sku_attachments;
create policy sku_attachments_all on public.sku_attachments for all to anon, authenticated using (true) with check (true);

-- Master data may exist before commercial data: a SKU's price can be set later.
-- (Applied to Supabase as "sku_price_nullable".)
alter table public.sku_master alter column price_case drop not null;
