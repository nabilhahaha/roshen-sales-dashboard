// Goods-Receiving service — batch-level QC and inventory posting.
//
// A Goods Receipt can only be created once its Delivery Note has exactly one
// matched Supplier Invoice. Warehouse staff set QC per batch (Released /
// Rejected). Inventory increases ONLY for Released batches, and only through
// inventory_movements (the source of truth) — the `inventory` view derives the
// on-hand balance from those movements. Below-minimum shelf-life accept/reject
// decisions are written to the audit log.
import { getClient, one } from '../supabase/client.js';
import { lineKey as keyOf } from '../../utils/format.js';
import { deliveryNoteHasMatchedInvoice } from '../supplier-invoice/supplier-invoice.service.js';

export async function listGoodsReceipts(orderId) {
  let q = getClient().from('goods_receipts')
    .select('*, delivery_notes(dn_number), supply_orders(order_number)')
    .order('created_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((g) => ({ ...g, delivery_note: one(g.delivery_notes), order: one(g.supply_orders) }));
}

export async function getGoodsReceipt(id) {
  const { data, error } = await getClient().from('goods_receipts')
    .select('*, delivery_notes(dn_number,po_reference), supply_orders(order_number,warehouse), goods_receipt_batches(*)')
    .eq('id', id).single();
  if (error) throw error;
  return {
    ...data, delivery_note: one(data.delivery_notes), order: one(data.supply_orders),
    batches: (data.goods_receipt_batches || []).sort((a, b) => (a.id || 0) - (b.id || 0)),
  };
}

// Create a GR from a DN (mirrors DN batches; received defaults to delivered).
// Enforces the invoice gate.
export async function createGoodsReceiptFromDeliveryNote(deliveryNoteId, opts = {}) {
  const c = getClient();
  if (!(await deliveryNoteHasMatchedInvoice(deliveryNoteId))) {
    throw new Error('This delivery note has no matched supplier invoice yet. Match an invoice before receiving.');
  }
  // one GR per DN
  const { data: existing } = await c.from('goods_receipts').select('id').eq('delivery_note_id', deliveryNoteId);
  if (existing && existing.length) return getGoodsReceipt(existing[0].id);

  const { data: dn, error: e0 } = await c.from('delivery_notes')
    .select('id,order_id, supply_orders(warehouse), delivery_note_items(id,item_code,roshen_id,description,uom,po_item_id, delivery_note_batches(*))')
    .eq('id', deliveryNoteId).single();
  if (e0) throw e0;
  const orderWarehouse = one(dn.supply_orders) && one(dn.supply_orders).warehouse;

  // matched invoice line ids for SI-line traceability
  const siIdx = {};
  const { data: inv } = await c.from('supplier_invoices').select('id').eq('delivery_note_id', deliveryNoteId).eq('status', 'Matched').limit(1);
  if (inv && inv.length) {
    const { data: siItems } = await c.from('supplier_invoice_items').select('id,item_code,roshen_id').eq('invoice_id', inv[0].id);
    (siItems || []).forEach((r) => { siIdx[keyOf(r.roshen_id, r.item_code)] = r.id; });
  }

  const { data: grRow, error: e1 } = await c.from('goods_receipts').insert({
    order_id: dn.order_id, delivery_note_id: deliveryNoteId,
    grn_number: opts.grn_number || ('GRN-' + Date.now()),
    warehouse: opts.warehouse || orderWarehouse || null,
    status: 'Pending QC', created_by: opts.createdBy || null,
  }).select().single();
  if (e1) {
    // lost a create race (unique on delivery_note_id) → return the winner
    if (e1.code === '23505') {
      const { data: won } = await c.from('goods_receipts').select('id').eq('delivery_note_id', deliveryNoteId).limit(1);
      if (won && won.length) return getGoodsReceipt(won[0].id);
    }
    throw e1;
  }

  const batches = [];
  (dn.delivery_note_items || []).forEach((it) => {
    (it.delivery_note_batches || []).forEach((b) => {
      batches.push({
        gr_id: grRow.id, dn_batch_id: b.id, dn_item_id: it.id,
        si_item_id: siIdx[keyOf(it.roshen_id, it.item_code)] || null, po_item_id: it.po_item_id || null,
        item_code: it.item_code, roshen_id: it.roshen_id, description: it.description, uom: it.uom,
        batch_no: b.batch_no, manufacturing_date: b.manufacturing_date, expiry_date: b.expiry_date,
        delivered_cases: b.cases || 0, received_cases: b.cases || 0,
        damaged_cases: 0, short_cases: 0, rejected_cases: 0, qc_result: 'Pending QC',
      });
    });
  });
  if (batches.length) {
    const { error: e2 } = await c.from('goods_receipt_batches').insert(batches);
    if (e2) throw e2;
  }
  await c.from('delivery_notes').update({ status: 'Receiving Review', updated_at: new Date().toISOString() }).eq('id', deliveryNoteId);
  return getGoodsReceipt(grRow.id);
}

// Update one GR batch's QC decision + quantities.
export async function setBatchQc(grBatchId, patch) {
  const upd = {};
  ['received_cases', 'damaged_cases', 'short_cases', 'rejected_cases', 'qc_result', 'qc_note'].forEach((k) => {
    if (patch[k] !== undefined) upd[k] = patch[k];
  });
  const { error } = await getClient().from('goods_receipt_batches').update(upd).eq('id', grBatchId);
  if (error) throw error;
}

// Record a shelf-life receiving exception (audit).
export async function recordShelfLifeException(ex) {
  const { error } = await getClient().from('shelf_life_exceptions').insert({
    order_id: ex.order_id || null, dn_id: ex.dn_id || null,
    dn_item_id: ex.dn_item_id || null, dn_batch_id: ex.dn_batch_id || null,
    item_code: ex.item_code || null, roshen_id: ex.roshen_id || null,
    batch_no: ex.batch_no || null, expiry_date: ex.expiry_date || null,
    required_pct: ex.required_pct != null ? ex.required_pct : null,
    remaining_pct: ex.remaining_pct != null ? ex.remaining_pct : null,
    decision: ex.decision, reason: ex.reason || null, decided_by: ex.decided_by || null,
  });
  if (error) throw error;
}

export async function listExceptions(orderId) {
  let q = getClient().from('shelf_life_exceptions').select('*').order('decided_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Release the GR: post an inventory movement for every Released batch (the
// `inventory` view derives on-hand from these — no read-then-write, no drift),
// then set header/DN status. Requires every batch to have a QC decision.
// costByKey optional (unit cost). Idempotent: an already-released GR is skipped.
export async function releaseGoodsReceipt(grId, opts = {}) {
  const c = getClient();
  const gr = await getGoodsReceipt(grId);
  if (['Released', 'Partially Released', 'Rejected'].includes(gr.status)) {
    return { status: gr.status, alreadyReleased: true,
      released: gr.batches.filter((b) => b.qc_result === 'Released').length,
      rejected: gr.batches.filter((b) => b.qc_result === 'Rejected').length, total: gr.batches.length };
  }
  const pending = gr.batches.filter((b) => b.qc_result === 'Pending QC');
  if (pending.length) throw new Error(`${pending.length} batch(es) still Pending QC — decide Release/Reject for every batch before releasing.`);

  const costByKey = opts.costByKey || {};
  const warehouse = opts.warehouse || gr.warehouse || (gr.order && gr.order.warehouse) || null;

  const released = gr.batches.filter((b) => b.qc_result === 'Released' && Number(b.received_cases || 0) > 0);
  for (const b of released) {
    const key = keyOf(b.roshen_id, b.item_code);
    const cost = costByKey[key] != null ? costByKey[key] : null;
    // movement — the single source of truth; the inventory view aggregates it
    const { error: em } = await c.from('inventory_movements').insert({
      order_id: gr.order_id, gr_id: gr.id, gr_batch_id: b.id, dn_batch_id: b.dn_batch_id,
      dn_id: gr.delivery_note_id,
      item_code: b.item_code, roshen_id: b.roshen_id, description: b.description,
      batch_no: b.batch_no, manufacturing_date: b.manufacturing_date, expiry_date: b.expiry_date,
      warehouse, movement_type: 'GR', cases_delta: Number(b.received_cases || 0),
      unit_cost: cost, reference: gr.grn_number, created_by: opts.releasedBy || null,
    });
    if (em) throw em;
    if (b.dn_batch_id) await c.from('delivery_note_batches').update({ qc_status: 'Released' }).eq('id', b.dn_batch_id);
  }
  // rejected DN batches
  for (const b of gr.batches.filter((x) => x.qc_result === 'Rejected')) {
    if (b.dn_batch_id) await c.from('delivery_note_batches').update({ qc_status: 'Rejected' }).eq('id', b.dn_batch_id);
  }

  const total = gr.batches.length;
  const rel = gr.batches.filter((b) => b.qc_result === 'Released').length;
  const rej = gr.batches.filter((b) => b.qc_result === 'Rejected').length;
  const status = rel === 0 ? 'Rejected' : rel === total ? 'Released' : 'Partially Released';
  await c.from('goods_receipts').update({
    status, warehouse, released_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', grId);
  await c.from('delivery_notes').update({
    status: rej === total ? 'Cancelled' : 'Received', received_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', gr.delivery_note_id);
  return { status, released: rel, rejected: rej, total };
}
