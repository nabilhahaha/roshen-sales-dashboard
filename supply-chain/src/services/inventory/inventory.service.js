// Inventory service — READ-ONLY screens over the Inventory Transaction
// Engine. Balances are always calculated from transactions (the
// inventory_balances view); the ledger is the transaction list itself.
// All writes go through inventory-transaction.service.js — nothing here
// (or anywhere else) updates a quantity directly.
import { listBalances, getLedger } from './inventory-transaction.service.js';

export async function listInventory({ inStockOnly = true } = {}) {
  const rows = await listBalances({ inStockOnly });
  // legacy shape used by the Inventory screen (description / cases_on_hand)
  return rows.map((r) => ({
    id: (r.sku_id || 0) * 1e6 + (r.batch_id || 0),
    sku_id: r.sku_id, batch_id: r.batch_id,
    roshen_id: r.roshen_id, item_code: r.item_code, description: r.item_description,
    batch_no: r.batch_no, manufacturing_date: r.manufacturing_date, expiry_date: r.expiry_date,
    warehouse: r.warehouse, cases_on_hand: r.cases_on_hand,
    qc_status: r.qc_status, hold_status: r.hold_status, updated_at: r.last_movement_at,
  }));
}

export async function listMovements(orderId) {
  return getLedger(orderId ? { orderId } : {});
}

export async function inventorySummary() {
  const rows = await listInventory({ inStockOnly: true });
  const skuSet = new Set();
  let cases = 0;
  rows.forEach((r) => { skuSet.add(r.sku_id || r.roshen_id || r.item_code); cases += Number(r.cases_on_hand || 0); });
  return { skus: skuSet.size, batches: rows.length, cases: +cases.toFixed(2) };
}
