// Inventory Transaction Engine — the ONLY component allowed to change stock.
//
// Every stock movement in the ERP (Goods Receipt, Delivery, Return,
// Adjustment, Write-off, Transfer, Production, Reversal) is posted here as an
// inventory TRANSACTION; balances are always calculated from transactions
// (inventory_balances / inventory_sku_balances views + batch_stock). No module
// updates a quantity directly — modules describe the business event, the
// engine writes the ledger. A DB trigger enriches every row (SKU spine,
// qty_in/qty_out, running balance) so even a bypassing insert cannot corrupt
// the ledger — but services must post through this engine.
import { getClient } from '../supabase/client.js';

// Transaction types and their quantity semantics.
export const TXN_TYPES = {
  GR:           { dir: +1, label: 'Goods Receipt' },
  RETURN:       { dir: +1, label: 'Return In' },
  TRANSFER_IN:  { dir: +1, label: 'Transfer In' },
  PRODUCTION:   { dir: +1, label: 'Production' },
  DELIVERY:     { dir: -1, label: 'Delivery Out' },
  WRITE_OFF:    { dir: -1, label: 'Write-off' },
  TRANSFER_OUT: { dir: -1, label: 'Transfer Out' },
  ADJUST:       { dir: 0,  label: 'Adjustment' },   // signed
  REVERSAL:     { dir: 0,  label: 'Reversal' },     // signed (usually negative)
};

const round2 = (v) => +Number(v || 0).toFixed(2);

async function batchInfo(batchId) {
  const { data, error } = await getClient().from('batch_master')
    .select('id,sku_id,batch_no,manufacturing_date,expiry_date,warehouse,gr_id,gr_batch_id,dn_batch_id,order_id')
    .eq('id', batchId).single();
  if (error) throw error;
  return data;
}

// Current balance for the exact ledger dimension (SKU + batch + warehouse).
export async function currentBalance({ skuId, batchId, warehouse }) {
  let q = getClient().from('inventory_movements').select('cases_delta');
  q = skuId != null ? q.eq('sku_id', skuId) : q.is('sku_id', null);
  q = batchId != null ? q.eq('batch_id', batchId) : q.is('batch_id', null);
  q = warehouse != null ? q.eq('warehouse', warehouse) : q.is('warehouse', null);
  const { data, error } = await q;
  if (error) throw error;
  return round2((data || []).reduce((a, m) => a + Number(m.cases_delta || 0), 0));
}

// Post ONE inventory transaction. txn:
//   { type, qty (positive; sign comes from the type) OR delta (signed, for
//     ADJUST/REVERSAL), skuId, batchId, warehouse, binLocation, uom, unitCost,
//     referenceModule, reference, actor, allowNegative,
//     context: { orderId, grId, grBatchId, dnBatchId, dnId, itemCode,
//                roshenId, description, batchNo, manufacturingDate, expiryDate } }
// Returns the ledger row (with Transaction ID + running balance).
export async function postTransaction(txn) {
  const t = TXN_TYPES[txn.type];
  if (!t) throw new Error(`Unknown transaction type "${txn.type}". Allowed: ${Object.keys(TXN_TYPES).join(', ')}.`);

  // resolve the batch dimension (fills SKU + batch data + default warehouse)
  let b = null;
  if (txn.batchId != null) b = await batchInfo(txn.batchId);
  const skuId = txn.skuId != null ? txn.skuId : (b ? b.sku_id : null);
  const warehouse = txn.warehouse !== undefined ? txn.warehouse : (b ? b.warehouse : null);

  // signed delta from the type semantics
  let delta;
  if (t.dir === 0) {
    if (txn.delta == null) throw new Error(`${txn.type} needs a signed delta.`);
    delta = Number(txn.delta);
  } else {
    const qty = Number(txn.qty != null ? txn.qty : txn.delta);
    if (!(qty > 0)) throw new Error(`${txn.type} needs a positive quantity.`);
    delta = t.dir * qty;
  }
  if (!delta) throw new Error('Transaction quantity must be non-zero.');

  // stock guard: outbound (and negative signed) transactions cannot take the
  // SKU+batch+warehouse balance below zero unless explicitly allowed
  // (REVERSAL always posts — it must be able to compensate in full).
  if (delta < 0 && txn.type !== 'REVERSAL' && !txn.allowNegative) {
    const bal = await currentBalance({ skuId, batchId: txn.batchId != null ? txn.batchId : null, warehouse });
    if (bal + delta < -0.0001) {
      throw new Error(`Insufficient stock: ${bal} case(s) on hand for this batch/warehouse, transaction needs ${-delta}.`);
    }
  }

  const ctx = txn.context || {};
  const { data, error } = await getClient().from('inventory_movements').insert({
    movement_type: txn.type,
    reference_module: txn.referenceModule || null,
    reference: txn.reference || null,
    sku_id: skuId, batch_id: txn.batchId != null ? txn.batchId : null,
    warehouse, bin_location: txn.binLocation || null,
    qty_in: delta > 0 ? delta : 0, qty_out: delta < 0 ? -delta : 0, cases_delta: delta,
    uom: txn.uom || 'CASE', unit_cost: txn.unitCost != null ? txn.unitCost : null,
    order_id: ctx.orderId || (b && b.order_id) || null,
    gr_id: ctx.grId || (b && b.gr_id) || null,
    gr_batch_id: ctx.grBatchId || (b && b.gr_batch_id) || null,
    dn_batch_id: ctx.dnBatchId || (b && b.dn_batch_id) || null,
    dn_id: ctx.dnId || null,
    item_code: ctx.itemCode || null, roshen_id: ctx.roshenId || null, description: ctx.description || null,
    batch_no: ctx.batchNo || (b && b.batch_no) || null,
    manufacturing_date: ctx.manufacturingDate || (b && b.manufacturing_date) || null,
    expiry_date: ctx.expiryDate || (b && b.expiry_date) || null,
    created_by: txn.actor || null,
  }).select().single();
  if (error) throw error;
  return data;
}

// Warehouse transfer = one TRANSFER_OUT + one TRANSFER_IN, same batch, linked
// by a shared reference. Fails before posting if source stock is insufficient.
export async function postTransfer({ batchId, qty, fromWarehouse, toWarehouse, binLocation, reference, actor }) {
  if (!toWarehouse || fromWarehouse === toWarehouse) throw new Error('Transfer needs two different warehouses.');
  const ref = reference || ('TRF-' + Date.now());
  const out = await postTransaction({
    type: 'TRANSFER_OUT', qty, batchId, warehouse: fromWarehouse,
    referenceModule: 'transfer', reference: ref, actor,
  });
  const inn = await postTransaction({
    type: 'TRANSFER_IN', qty, batchId, warehouse: toWarehouse, binLocation,
    referenceModule: 'transfer', reference: ref, actor,
  });
  return { reference: ref, out, in: inn };
}

// ---- reads: balances are ALWAYS calculated from transactions -----------
export async function listBalances({ skuId, batchId, warehouse, inStockOnly = true } = {}) {
  let q = getClient().from('inventory_balances').select('*').order('expiry_date', { ascending: true, nullsFirst: false });
  if (skuId) q = q.eq('sku_id', skuId);
  if (batchId) q = q.eq('batch_id', batchId);
  if (warehouse) q = q.eq('warehouse', warehouse);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  return inStockOnly ? rows.filter((r) => Number(r.cases_on_hand) !== 0) : rows;
}

export async function listSkuBalances({ warehouse } = {}) {
  let q = getClient().from('inventory_sku_balances').select('*').order('item_description');
  if (warehouse) q = q.eq('warehouse', warehouse);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getLedger({ skuId, batchId, warehouse, type, orderId, limit = 500 } = {}) {
  let q = getClient().from('inventory_movements').select('*').order('created_at', { ascending: false }).limit(limit);
  if (skuId) q = q.eq('sku_id', skuId);
  if (batchId) q = q.eq('batch_id', batchId);
  if (warehouse) q = q.eq('warehouse', warehouse);
  if (type) q = q.eq('movement_type', type);
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}
