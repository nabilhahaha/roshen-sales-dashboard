// Delivery-Note service — persistence for delivery notes, their SKU lines and
// physical batches. Preserves the PO-line → DN-line → DN-batch traceability
// chain. Pages talk to this; only this talks to Supabase.
import { getClient, one } from '../supabase/client.js';
import { lineKey as keyOf } from '../../utils/format.js';
import { reverseReleasedGoodsReceipt } from '../goods-receiving/goods-receiving.service.js';

// ---- audit trail ----------------------------------------------------
export async function logDnAudit(dnId, orderId, action, { detail, note, actor } = {}) {
  const { error } = await getClient().from('dn_audit_log').insert({
    dn_id: dnId, order_id: orderId || null, action, detail: detail || null, note: note || null, actor: actor || null,
  });
  if (error) throw error;
}
export async function listDnAudit(dnId) {
  const { data, error } = await getClient().from('dn_audit_log')
    .select('*').eq('dn_id', dnId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}
// compact snapshot of a DN's lines/batches for before/after audit detail
function dnSnapshot(dn) {
  return {
    status: dn.status, dn_number: dn.dn_number, dn_date: dn.dn_date, po_reference: dn.po_reference,
    total_cartons: dn.total_cartons,
    lines: (dn.items || []).map((it) => ({
      roshen_id: it.roshen_id, item_code: it.item_code,
      cases: (it.batches || []).reduce((a, b) => a + Number(b.cases || 0), 0),
      batches: (it.batches || []).map((b) => ({ batch_no: b.batch_no, expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date, cases: b.cases })),
    })),
  };
}

// Orders that have reached the phase where deliveries can arrive.
export const RECEIVABLE_STATUSES = [
  'PI Approved', 'Ready for Shipment',
  'Partially Delivered', 'Fully Delivered',
  'Partially Received', 'Fully Received', 'Invoice Matched',
];

export async function listReceivableOrders() {
  const { data, error } = await getClient().from('supply_orders')
    .select('id,order_number,order_date,supplier,warehouse,status,current_revision')
    .in('status', RECEIVABLE_STATUSES)
    .order('order_date', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getOrder(orderId) {
  const { data, error } = await getClient().from('supply_orders')
    .select('id,order_number,order_date,supplier,warehouse,status,current_revision').eq('id', orderId).single();
  if (error) throw error;
  return data;
}

// Per-line fulfillment ledger (ordered/delivered/invoiced/received + opens).
export async function getFulfillment(orderId) {
  const { data, error } = await getClient().from('po_line_fulfillment')
    .select('*').eq('order_id', orderId).order('line_key');
  if (error) throw error;
  return data || [];
}

// line_key -> supply_order_items.id  (for DN-line traceability)
async function poItemIndex(orderId) {
  const { data, error } = await getClient().from('supply_order_items')
    .select('id,item_code,roshen_id').eq('order_id', orderId);
  if (error) throw error;
  const idx = {};
  (data || []).forEach((r) => { idx[keyOf(r.roshen_id, r.item_code)] = r.id; });
  return idx;
}

// dn: { orderId, header:{dn_number,dn_date,supplier,po_reference,currency,total_cartons,notes,source_filename,header_extra},
//       lines:[{item_code,roshen_id,description,uom,barcode,line_key, batches:[{batch_no,manufacturing_date,expiry_date,cases,boxes,pieces,belowMinimum}]}],
//       createdBy }
// Find an existing DN header for this order + number (idempotency key).
async function findDeliveryNoteRow(orderId, dnNumber) {
  if (!dnNumber) return null;
  const { data, error } = await getClient().from('delivery_notes')
    .select('*').eq('order_id', orderId).eq('dn_number', dnNumber).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function createDeliveryNote(dn) {
  const c = getClient();
  const dnNumber = dn.header.dn_number || ('DN-' + Date.now());

  // Idempotency: a delivery note is unique per (order, dn_number). If it was
  // already created (e.g. a double submit), return the existing record instead
  // of inserting again — never duplicate the lines/batches.
  const already = await findDeliveryNoteRow(dn.orderId, dnNumber);
  if (already) return already;

  const poIdx = await poItemIndex(dn.orderId);

  const insertHeader = () => c.from('delivery_notes').insert({
    order_id: dn.orderId,
    dn_number: dnNumber,
    dn_date: dn.header.dn_date || null,
    supplier: dn.header.supplier || null,
    po_reference: dn.header.po_reference || null,
    currency: dn.header.currency || 'SAR',
    total_cartons: dn.header.total_cartons != null ? dn.header.total_cartons : null,
    notes: dn.header.notes || null,
    source_filename: dn.header.source_filename || null,
    header_extra: dn.header.header_extra || null,
    status: 'Imported',
    created_by: dn.createdBy || null,
  }).select().single();

  let { data: dnRow, error: e1 } = await insertHeader();
  if (e1) {
    // lost a create race → the other insert won; return that record
    if (e1.code === '23505') {
      const winner = await findDeliveryNoteRow(dn.orderId, dnNumber);
      if (winner) return winner;
    }
    throw e1;
  }

  await insertLinesAndBatches(dnRow.id, poIdx, dn.lines);
  try { await logDnAudit(dnRow.id, dn.orderId, 'created', { detail: { dn_number: dnNumber, lines: dn.lines.length }, actor: dn.createdBy }); } catch (e) { /* audit best-effort */ }
  return dnRow;
}

// Insert a DN's SKU lines + physical batches (shared by create and edit).
async function insertLinesAndBatches(dnId, poIdx, lines) {
  const c = getClient();
  for (const line of lines || []) {
    const lk = line.line_key || keyOf(line.roshen_id, line.item_code);
    const { data: itemRow, error: e2 } = await c.from('delivery_note_items').insert({
      dn_id: dnId,
      po_item_id: poIdx[lk] || null,
      item_code: line.item_code || null,
      roshen_id: line.roshen_id || null,
      description: line.description || null,
      uom: line.uom || null,
      barcode: line.barcode || null,
      match_status: line.kind || (poIdx[lk] ? 'matched' : 'additional'),
    }).select().single();
    if (e2) throw e2;

    const batches = (line.batches || []).map((b) => ({
      dn_item_id: itemRow.id,
      batch_no: b.batch_no || null,
      manufacturing_date: b.manufacturing_date || null,
      expiry_date: b.expiry_date || null,
      cases: b.cases || 0,
      boxes: b.boxes != null ? b.boxes : null,
      pieces: b.pieces != null ? b.pieces : null,
      qc_status: 'Pending QC',
      shelf_life_flag: b.belowMinimum ? 'below_minimum' : 'ok',
    }));
    if (batches.length) {
      const { error: e3 } = await c.from('delivery_note_batches').insert(batches);
      if (e3) throw e3;
    }
  }
}

export async function listDeliveryNotes(orderId) {
  let q = getClient().from('delivery_notes')
    .select('*, supply_orders(order_number,status), supplier_invoices(id,invoice_number,status), goods_receipts(id,status)')
    .order('imported_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((d) => ({
    ...d,
    order: one(d.supply_orders),
    invoice: one(d.supplier_invoices),
    goods_receipt: one(d.goods_receipts),
  }));
}

export async function getDeliveryNote(id) {
  const { data, error } = await getClient().from('delivery_notes')
    .select('*, supply_orders(id,order_number,status,warehouse), ' +
            'delivery_note_items(*, delivery_note_batches(*)), ' +
            'supplier_invoices(*, supplier_invoice_items(*)), ' +
            'goods_receipts(*, goods_receipt_batches(*))')
    .eq('id', id).single();
  if (error) throw error;
  // A delivery note may now carry several invoices (partial invoicing + credit/
  // debit notes). Pick a primary for the header/gate — a Matched tax invoice
  // wins, else Partially Matched, else the most recent non-cancelled.
  const invoices = (data.supplier_invoices || []);
  const primary = pickPrimaryInvoice(invoices);
  return {
    ...data,
    order: one(data.supply_orders),
    items: (data.delivery_note_items || []).map((it) => ({ ...it, batches: it.delivery_note_batches || [] })),
    invoice: primary,
    invoices,
    goods_receipt: one(data.goods_receipts),
  };
}

function pickPrimaryInvoice(invoices) {
  const active = (invoices || []).filter((i) => (i.doc_type == null || i.doc_type === 'invoice') && i.status !== 'Cancelled' && i.status !== 'Replaced');
  const rank = (s) => (s === 'Matched' ? 3 : s === 'Partially Matched' ? 2 : 1);
  return active.slice().sort((a, b) => rank(b.status) - rank(a.status) || (b.id - a.id))[0] || null;
}

export async function setDeliveryNoteStatus(id, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'Received') patch.received_at = new Date().toISOString();
  const { error } = await getClient().from('delivery_notes').update(patch).eq('id', id);
  if (error) throw error;
}

const hasReleasedGr = (gr) => gr && ['Released', 'Partially Released'].includes(gr.status);

// Edit a delivery note's header / lines / batches. Allowed only before goods
// have been received. Records a before/after audit entry. The batch triggers
// keep the fulfillment ledger consistent.
export async function editDeliveryNote(dnId, { header, lines }, actor) {
  const dn = await getDeliveryNote(dnId);
  if (['Cancelled', 'Reversed'].includes(dn.status)) throw new Error(`Cannot edit a ${dn.status.toLowerCase()} delivery note.`);
  if (hasReleasedGr(dn.goods_receipt)) throw new Error('Cannot edit — goods have already been received. Reverse the receipt first.');
  const c = getClient();
  const before = dnSnapshot(dn);

  if (header) {
    const patch = { updated_at: new Date().toISOString() };
    ['dn_date', 'supplier', 'po_reference', 'notes', 'total_cartons'].forEach((k) => { if (header[k] !== undefined) patch[k] = header[k]; });
    const { error } = await c.from('delivery_notes').update(patch).eq('id', dnId);
    if (error) throw error;
  }
  if (lines) {
    const { error: eDel } = await c.from('delivery_note_items').delete().eq('dn_id', dnId); // cascade drops batches
    if (eDel) throw eDel;
    await insertLinesAndBatches(dnId, await poItemIndex(dn.order_id), lines);
  }
  const after = dnSnapshot(await getDeliveryNote(dnId));
  await logDnAudit(dnId, dn.order_id, 'edited', { detail: { before, after }, actor });
  return { edited: true };
}

// Cancel a delivery note (before receiving). Excluded from the fulfillment
// ledger; the PO balance reverts automatically.
export async function cancelDeliveryNote(dnId, { reason, actor } = {}) {
  const dn = await getDeliveryNote(dnId);
  if (dn.status === 'Cancelled') return { cancelled: true };
  if (hasReleasedGr(dn.goods_receipt)) throw new Error('Cannot cancel — goods already received. Use Reverse instead.');
  const { error } = await getClient().from('delivery_notes')
    .update({ status: 'Cancelled', updated_at: new Date().toISOString() }).eq('id', dnId);
  if (error) throw error;
  await logDnAudit(dnId, dn.order_id, 'cancelled', { note: reason, actor });
  return { cancelled: true };
}

// Reverse a delivery note whose goods were already received: post compensating
// inventory movements (via the goods-receiving service), cancel the receipt,
// and mark the DN Reversed — with a full audit trail.
export async function reverseDeliveryNote(dnId, { reason, actor } = {}) {
  const dn = await getDeliveryNote(dnId);
  if (dn.status === 'Reversed') return { reversed: true };
  let reversal = null;
  if (hasReleasedGr(dn.goods_receipt)) {
    reversal = await reverseReleasedGoodsReceipt(dn.goods_receipt.id, { actor, reason });
  }
  const { error } = await getClient().from('delivery_notes')
    .update({ status: 'Reversed', updated_at: new Date().toISOString() }).eq('id', dnId);
  if (error) throw error;
  await logDnAudit(dnId, dn.order_id, 'reversed', { note: reason, actor, detail: { grn: dn.goods_receipt ? dn.goods_receipt.grn_number : null, reversal } });
  return { reversed: true };
}
