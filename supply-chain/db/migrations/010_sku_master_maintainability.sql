-- =====================================================================
-- Migration 010 — SKU Master maintainability
--
-- SKU Master becomes the single, fully-maintainable source of truth. Adds the
-- pack attributes it must own (unit weight + units per carton), a change audit
-- log, and a remembered-mapping table so that once a user manually maps an
-- imported sheet description to a SKU, future Shelf-Life imports reuse it.
--
-- Additive and backward compatible. Applied to Supabase as
-- "sku_master_maintainability".
-- =====================================================================

alter table public.sku_master
  add column if not exists unit_weight_g    numeric,   -- net weight per unit, grams
  add column if not exists units_per_carton integer;

-- Change audit log for every SKU (create / edit / activate / deactivate /
-- shelf-life import).
create table if not exists public.sku_audit_log (
  id         bigint generated always as identity primary key,
  sku_id     bigint references public.sku_master(id) on delete cascade,
  action     text not null,            -- created | updated | activated | deactivated | shelf_import
  detail     jsonb,                    -- { before, after } or import context
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists idx_sku_audit_sku on public.sku_audit_log(sku_id);

-- Remembered manual mappings: a sheet description the user mapped to a SKU, so
-- later imports of the same description resolve deterministically.
create table if not exists public.shelf_life_import_mappings (
  id                 bigint generated always as identity primary key,
  source_description text not null,
  norm_description   text not null unique,   -- lowercased/collapsed for lookup
  sku_id             bigint references public.sku_master(id) on delete cascade,
  created_by         text,
  created_at         timestamptz not null default now()
);
create index if not exists idx_sl_mappings_sku on public.shelf_life_import_mappings(sku_id);

alter table public.sku_audit_log enable row level security;
drop policy if exists sku_audit_log_all on public.sku_audit_log;
create policy sku_audit_log_all on public.sku_audit_log
  for all to anon, authenticated using (true) with check (true);

alter table public.shelf_life_import_mappings enable row level security;
drop policy if exists shelf_life_import_mappings_all on public.shelf_life_import_mappings;
create policy shelf_life_import_mappings_all on public.shelf_life_import_mappings
  for all to anon, authenticated using (true) with check (true);
