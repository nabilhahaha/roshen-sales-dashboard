// Batch / Lot Master service — the core batch entity every downstream module
// references by internal Batch ID (Goods Receipt creates batches automatically;
// Inventory, QC, FEFO, Returns and Stock Adjustments all work per batch).
//
// Quantities are movement-derived and shelf life is date-derived — both come
// from the batch_stock VIEW (current / reserved / available + remaining days
// and %), never stored. Every state change lands in batch_audit_log; every
// quantity change is an inventory_movement carrying batch_id.
import { getClient } from '../supabase/client.js';
import { postTransaction, postTransfer } from '../inventory/inventory-transaction.service.js';

// ---- audit ----------------------------------------------------------
export async function logBatchAudit(batchId, action, { detail, note, actor } = {}) {
  const { error } = await getClient().from('batch_audit_log').insert({
    batch_id: batchId, action, detail: detail || null, note: note || null, actor: actor || null,
  });
  if (error) throw error;
}
export async function listBatchAudit(batchId) {
  const { data, error } = await getClient().from('batch_audit_log')
    .select('*').eq('batch_id', batchId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---- reads (batch_stock = master + live qty + live shelf life) -------
export async function listBatchStock({ skuId, warehouse, withStockOnly = false } = {}) {
  let q = getClient().from('batch_stock').select('*').order('expiry_date', { ascending: true, nullsFirst: false });
  if (skuId) q = q.eq('sku_id', skuId);
  if (warehouse) q = q.eq('warehouse', warehouse);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data || [];
  return withStockOnly ? rows.filter((r) => Number(r.current_cases || 0) !== 0) : rows;
}

export async function getBatch(batchId) {
  const c = getClient();
  const [{ data: b, error: e1 }, movements, audit, { data: res }] = await Promise.all([
    c.from('batch_stock').select('*').eq('id', batchId).single(),
    c.from('inventory_movements').select('*').eq('batch_id', batchId).order('created_at'),
    listBatchAudit(batchId),
    c.from('batch_reservations').select('*').eq('batch_id', batchId).order('created_at'),
  ]);
  if (e1) throw e1;
  if (movements.error) throw movements.error;
  return { ...b, movements: movements.data || [], audit, reservations: res || [] };
}

// ---- creation (called by Goods Receipt — automatic) ------------------
// grBatches: goods_receipt_batches rows (with sku_id). Creates one batch_master
// per GR batch and links GR batch + DN batch to it. Idempotent per gr_batch_id.
export async function createBatchesForGoodsReceipt(gr, grBatches, { actor } = {}) {
  const c = getClient();
  const out = [];
  for (const gb of grBatches || []) {
    if (!gb.sku_id) continue;   // unresolvable line — stays unlinked, surfaced by GR screen
    const { data: row, error } = await c.from('batch_master').insert({
      sku_id: gb.sku_id, batch_no: gb.batch_no || null, supplier_batch_no: gb.supplier_batch_no || gb.batch_no || null,
      manufacturing_date: gb.manufacturing_date || null, expiry_date: gb.expiry_date || null,
      received_date: gr.receipt_date || new Date().toISOString().slice(0, 10),
      qc_status: 'Pending QC', supplier: gr.supplier || null, warehouse: gr.warehouse || null,
      order_id: gr.order_id || null, gr_id: gr.id, gr_batch_id: gb.id, dn_batch_id: gb.dn_batch_id || null,
      created_by: actor || null,
    }).select().single();
    if (error) {
      if (error.code === '23505') continue;   // already created (race / re-run)
      throw error;
    }
    await c.from('goods_receipt_batches').update({ batch_id: row.id }).eq('id', gb.id);
    if (gb.dn_batch_id) await c.from('delivery_note_batches').update({ batch_id: row.id }).eq('id', gb.dn_batch_id);
    try { await logBatchAudit(row.id, 'created', { detail: { grn: gr.grn_number, batch_no: row.batch_no, expiry: row.expiry_date }, actor }); } catch (e) { /* best-effort */ }
    out.push(row);
  }
  return out;
}

// ---- QC / hold state (batches are approved/rejected — not products) ---
export async function setBatchQcStatus(batchId, qcStatus, { note, actor } = {}) {
  if (!['Pending QC', 'Released', 'Rejected'].includes(qcStatus)) throw new Error('Invalid QC status.');
  const { error } = await getClient().from('batch_master')
    .update({ qc_status: qcStatus, updated_at: new Date().toISOString() }).eq('id', batchId);
  if (error) throw error;
  try { await logBatchAudit(batchId, qcStatus === 'Released' ? 'qc_released' : qcStatus === 'Rejected' ? 'qc_rejected' : 'qc_reset', { note, actor }); } catch (e) { /* best-effort */ }
}

export async function holdBatch(batchId, { reason, actor } = {}) {
  const { error } = await getClient().from('batch_master')
    .update({ hold_status: 'on_hold', hold_reason: reason || null, updated_at: new Date().toISOString() }).eq('id', batchId);
  if (error) throw error;
  await logBatchAudit(batchId, 'held', { note: reason, actor });
}
export async function unholdBatch(batchId, { actor } = {}) {
  const { error } = await getClient().from('batch_master')
    .update({ hold_status: 'none', hold_reason: null, updated_at: new Date().toISOString() }).eq('id', batchId);
  if (error) throw error;
  await logBatchAudit(batchId, 'unheld', { actor });
}

// ---- stock adjustment / write-off / transfer (via the Transaction Engine)
// Batches never touch quantities directly — every change is a posted
// inventory transaction; the engine enforces the stock guard.
export async function adjustBatchStock(batchId, casesDelta, { reason, actor } = {}) {
  const delta = Number(casesDelta);
  if (!delta) throw new Error('Adjustment quantity must be non-zero.');
  const b = await getBatch(batchId);
  await postTransaction({
    type: 'ADJUST', delta, batchId, warehouse: b.warehouse,
    referenceModule: 'inventory', reference: 'ADJUST batch #' + batchId + (reason ? ' — ' + reason : ''), actor,
    context: { itemCode: b.item_code, roshenId: b.roshen_id, description: b.item_description },
  });
  await logBatchAudit(batchId, 'adjusted', { detail: { cases_delta: delta }, note: reason, actor });
  return { adjusted: true, delta };
}

export async function writeOffBatch(batchId, cases, { reason, actor } = {}) {
  const b = await getBatch(batchId);
  await postTransaction({
    type: 'WRITE_OFF', qty: Number(cases), batchId, warehouse: b.warehouse,
    referenceModule: 'inventory', reference: 'WRITE-OFF batch #' + batchId + (reason ? ' — ' + reason : ''), actor,
    context: { itemCode: b.item_code, roshenId: b.roshen_id, description: b.item_description },
  });
  await logBatchAudit(batchId, 'adjusted', { detail: { write_off: Number(cases) }, note: reason, actor });
  return { writtenOff: true, cases: Number(cases) };
}

export async function transferBatch(batchId, cases, { toWarehouse, binLocation, actor } = {}) {
  const b = await getBatch(batchId);
  const r = await postTransfer({ batchId, qty: Number(cases), fromWarehouse: b.warehouse, toWarehouse, binLocation, actor });
  await logBatchAudit(batchId, 'adjusted', { detail: { transfer: Number(cases), from: b.warehouse, to: toWarehouse, reference: r.reference }, actor });
  return r;
}

// ---- reservations ------------------------------------------------------
export async function reserveBatch(batchId, cases, { reason, reference, actor } = {}) {
  const qty = Number(cases);
  if (!(qty > 0)) throw new Error('Reservation quantity must be positive.');
  const b = await getBatch(batchId);
  if (qty > Number(b.available_cases)) throw new Error(`Only ${b.available_cases} case(s) available on this batch.`);
  const { data, error } = await getClient().from('batch_reservations')
    .insert({ batch_id: batchId, cases: qty, reason: reason || null, reference: reference || null, created_by: actor || null })
    .select().single();
  if (error) throw error;
  await logBatchAudit(batchId, 'reserved', { detail: { cases: qty, reference }, note: reason, actor });
  return data;
}
export async function releaseReservation(reservationId, { actor, consumed = false } = {}) {
  const { data, error } = await getClient().from('batch_reservations')
    .update({ status: consumed ? 'Consumed' : 'Released', released_at: new Date().toISOString() })
    .eq('id', reservationId).select().single();
  if (error) throw error;
  try { await logBatchAudit(data.batch_id, 'unreserved', { detail: { cases: data.cases, consumed } , actor }); } catch (e) { /* best-effort */ }
  return data;
}

// ---- FEFO allocation ----------------------------------------------------
// Pure allocator: given batch_stock-shaped rows, allocate qty from the OLDEST
// valid batch first. Valid = QC Released, not on hold, not expired (asOf),
// available > 0. Returns { allocations:[{batch, cases}], remaining, satisfied }.
export function allocateFefo(rows, qty, { asOf } = {}) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const eligible = (rows || [])
    .filter((b) => b.qc_status === 'Released' && b.hold_status !== 'on_hold')
    .filter((b) => !b.expiry_date || b.expiry_date > today)
    .filter((b) => Number(b.available_cases || 0) > 0)
    .sort((a, b) => String(a.expiry_date || '9999-12-31').localeCompare(String(b.expiry_date || '9999-12-31')) || (a.id - b.id));
  let remaining = Number(qty);
  const allocations = [];
  for (const b of eligible) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.available_cases));
    allocations.push({ batch: b, cases: take });
    remaining = +(remaining - take).toFixed(2);
  }
  return { allocations, remaining, satisfied: remaining <= 0 };
}

// Query + allocate for a SKU (optionally per warehouse). Preview by default;
// pass reserve:true to persist the allocation as Active reservations.
export async function fefoAllocate(skuId, qty, { warehouse, reserve = false, reason, reference, actor } = {}) {
  const rows = await listBatchStock({ skuId, warehouse });
  const plan = allocateFefo(rows, qty);
  if (reserve && plan.allocations.length) {
    for (const a of plan.allocations) {
      await reserveBatch(a.batch.id, a.cases, { reason: reason || 'FEFO allocation', reference, actor });
    }
  }
  return plan;
}
