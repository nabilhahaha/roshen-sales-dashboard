// SKU Master service — the imported Roshen SKU catalogue.
import { getClient } from '../supabase/client.js';

const SELECT = 'roshen_id,item_code,item_description,price_case,status';

export async function listSkus({ activeOnly = true } = {}) {
  let q = getClient().from('sku_master').select(activeOnly ? SELECT : '*').order('item_description');
  if (activeOnly) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
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
