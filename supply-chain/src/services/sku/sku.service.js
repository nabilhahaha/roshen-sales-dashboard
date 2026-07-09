// SKU Master service — the imported Roshen SKU catalogue.
import { getClient } from '../supabase/client.js';

const SELECT = 'id,roshen_id,item_code,item_description,price_case,status,' +
  'shelf_life_value,shelf_life_unit,min_remaining_shelf_life_pct';

export async function listSkus({ activeOnly = true } = {}) {
  let q = getClient().from('sku_master').select(activeOnly ? SELECT : '*').order('item_description');
  if (activeOnly) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Update shelf-life master data (maintained manually in SKU Master).
export async function updateShelfLife(id, { shelf_life_value, shelf_life_unit, min_remaining_shelf_life_pct }) {
  const patch = {
    shelf_life_value: shelf_life_value === '' || shelf_life_value == null ? null : Number(shelf_life_value),
    shelf_life_unit: shelf_life_unit || null,
    min_remaining_shelf_life_pct: min_remaining_shelf_life_pct === '' || min_remaining_shelf_life_pct == null ? null : Number(min_remaining_shelf_life_pct),
    updated_at: new Date().toISOString(),
  };
  const { error } = await getClient().from('sku_master').update(patch).eq('id', id);
  if (error) throw error;
}

export async function countSkus() {
  const { count, error } = await getClient()
    .from('sku_master').select('id', { count: 'exact', head: true }).eq('status', 'active');
  if (error) throw error;
  return count || 0;
}

// index helpers used by the order editor
export function indexByCode(skus) {
  const m = {};
  skus.forEach((s) => { m[s.item_code] = s; });
  return m;
}
export function indexByRoshen(skus) {
  const m = {};
  skus.forEach((s) => { if (s.roshen_id) m[String(s.roshen_id).trim()] = s; });
  return m;
}
