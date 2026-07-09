-- =====================================================================
-- Migration 012 — automatic document → SKU linkage
--
-- Every new document line (PO / DN / SI / GR) is linked to its SKU Master row
-- at insert time by a trigger: Item Code first (unique), else an unambiguous
-- Roshen ID. This runs in the database so NO application path can create a
-- document line without the SKU spine. The document's own copied fields
-- (code, description, price) remain the immutable historical snapshot.
-- Applied to Supabase as "sku_autolink_triggers".
-- =====================================================================
create or replace function public.link_sku_id() returns trigger
language plpgsql as $$
begin
  if new.sku_id is not null then return new; end if;
  if new.item_code is not null then
    select id into new.sku_id from public.sku_master where item_code = new.item_code limit 1;
  end if;
  if new.sku_id is null and new.roshen_id is not null then
    select min(id) into new.sku_id from public.sku_master s
     where regexp_replace(s.roshen_id, '^0+(?=\d)', '') = regexp_replace(new.roshen_id, '^0+(?=\d)', '')
       and (select count(*) from public.sku_master s2
             where regexp_replace(s2.roshen_id, '^0+(?=\d)', '') = regexp_replace(new.roshen_id, '^0+(?=\d)', '')) = 1;
  end if;
  return new;
end $$;

drop trigger if exists trg_link_sku_soi on public.supply_order_items;
create trigger trg_link_sku_soi before insert on public.supply_order_items
  for each row execute function public.link_sku_id();
drop trigger if exists trg_link_sku_dni on public.delivery_note_items;
create trigger trg_link_sku_dni before insert on public.delivery_note_items
  for each row execute function public.link_sku_id();
drop trigger if exists trg_link_sku_sii on public.supplier_invoice_items;
create trigger trg_link_sku_sii before insert on public.supplier_invoice_items
  for each row execute function public.link_sku_id();
drop trigger if exists trg_link_sku_grb on public.goods_receipt_batches;
create trigger trg_link_sku_grb before insert on public.goods_receipt_batches
  for each row execute function public.link_sku_id();
