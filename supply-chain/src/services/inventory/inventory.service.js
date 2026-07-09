// Inventory service — read-only views over the movement-based inventory.
// Balances live in `inventory`; every change is recorded in
// `inventory_movements` (the source of truth). FEFO-ready: on-hand stock is
// ordered by expiry date.
import { getClient } from '../supabase/client.js';

export async function listInventory({ inStockOnly = true } = {}) {
  let q = getClient().from('inventory').select('*').order('expiry_date', { ascending: true, nullsFirst: false });
  if (inStockOnly) q = q.gt('cases_on_hand', 0);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function listMovements(orderId) {
  let q = getClient().from('inventory_movements').select('*').order('created_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function inventorySummary() {
  const rows = await listInventory({ inStockOnly: true });
  const skuSet = new Set(), batchCount = rows.length;
  let cases = 0;
  rows.forEach((r) => { skuSet.add(r.roshen_id || r.item_code); cases += Number(r.cases_on_hand || 0); });
  return { skus: skuSet.size, batches: batchCount, cases: +cases.toFixed(2) };
}
