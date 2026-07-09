// Supplier-Invoice service — the supplier invoice is RECEIVED as the supplier's
// own document (PDF now, ZATCA XML later). It is uploaded, its data extracted,
// stored with the original file for audit, and validated against the Delivery
// Note. Each DN needs exactly one matched invoice before its Goods Receipt can
// be released.
import { getClient, one } from '../supabase/client.js';
import { lineKey as keyOf } from '../../utils/format.js';
import { compareInvoiceToDeliveryNote } from './invoice-compare.js';

// ---- original-document storage (audit) ------------------------------
// The original PDF is kept as base64 in supplier_invoice_documents (under this
// module's own RLS) — storage.objects carries Sales-Dashboard policies anon
// cannot evaluate. Fetched only when the user views the file.
export async function saveInvoiceDocument(invoiceId, orderId, doc) {
  const { error } = await getClient().from('supplier_invoice_documents').insert({
    invoice_id: invoiceId, order_id: orderId || null,
    filename: doc.name || 'invoice.pdf', mime: doc.mime || 'application/pdf',
    byte_size: doc.size || null, data: doc.base64 || null, created_by: doc.createdBy || null,
  });
  if (error) throw error;
}

export async function getInvoiceDocument(invoiceId) {
  const { data, error } = await getClient().from('supplier_invoice_documents')
    .select('filename,mime,data').eq('invoice_id', invoiceId).order('created_at', { ascending: false }).limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

export async function listInvoices(orderId) {
  let q = getClient().from('supplier_invoices')
    .select('*, delivery_notes(dn_number)').order('created_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map((i) => ({ ...i, delivery_note: one(i.delivery_notes) }));
}

export async function getInvoice(id) {
  const { data, error } = await getClient().from('supplier_invoices')
    .select('*, supplier_invoice_items(*), delivery_notes(dn_number)').eq('id', id).single();
  if (error) throw error;
  return { ...data, items: data.supplier_invoice_items || [], delivery_note: one(data.delivery_notes) };
}

// DN → invoice match context: expected net (delivered cartons × PO case price),
// DN/PO references and line count. Shared by the upload validation and re-check.
async function deliveryNoteMatchContext(deliveryNoteId) {
  const c = getClient();
  const { data: dn, error } = await c.from('delivery_notes')
    .select('dn_number,po_reference,order_id, delivery_note_items(item_code,roshen_id, delivery_note_batches(cases))')
    .eq('id', deliveryNoteId).single();
  if (error) throw error;
  const { data: ful } = await c.from('po_line_fulfillment').select('line_key,price_case').eq('order_id', dn.order_id);
  const priceByKey = {};
  (ful || []).forEach((r) => { priceByKey[r.line_key] = Number(r.price_case || 0); });
  let expectedNet = 0; let lineCount = 0;
  (dn.delivery_note_items || []).forEach((it) => {
    const key = keyOf(it.roshen_id, it.item_code);
    const cartons = (it.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    expectedNet += cartons * (priceByKey[key] || 0);
    lineCount++;
  });
  return { orderId: dn.order_id, dnNumber: dn.dn_number, poReference: dn.po_reference, expectedNet: +expectedNet.toFixed(2), lineCount };
}

// Create an invoice from an uploaded supplier document (PDF). Stores the header,
// the extracted payload + validation outcome, the original file for audit, and
// the (user-verified, SKU-bound) line items. `status` is decided by the
// validation screen: Matched unlocks goods receiving, Disputed does not.
// inv: { orderId, deliveryNoteId, header, totals, lines, document:{name,mime,size,base64},
//        extracted, validation, status, createdBy }
export async function createSupplierInvoiceFromUpload(inv) {
  const c = getClient();
  const lines = inv.lines || [];
  const total_taxable = inv.totals && inv.totals.taxable != null
    ? Number(inv.totals.taxable) : +lines.reduce((a, l) => a + Number(l.taxable_amount || 0), 0).toFixed(2);
  const total_vat = inv.totals && inv.totals.vat != null
    ? Number(inv.totals.vat) : +lines.reduce((a, l) => a + Number(l.vat_amount || 0), 0).toFixed(2);
  const grand = inv.totals && inv.totals.grand != null ? Number(inv.totals.grand) : +(total_taxable + total_vat).toFixed(2);

  const dnItemIdx = {}, poItemIdx = {};
  if (inv.deliveryNoteId) {
    // A delivery note has exactly one supplier invoice. Replacing it is only
    // safe before any goods receipt exists — once received, the invoice
    // justifies posted inventory and its line ids are referenced by GR batches.
    const { data: grs } = await c.from('goods_receipts').select('id').eq('delivery_note_id', inv.deliveryNoteId);
    const { data: prev } = await c.from('supplier_invoices').select('id').eq('delivery_note_id', inv.deliveryNoteId);
    if (prev && prev.length) {
      if (grs && grs.length) throw new Error('A goods receipt already exists for this delivery note — the supplier invoice can no longer be replaced.');
      const { error: delErr } = await c.from('supplier_invoices').delete().in('id', prev.map((p) => p.id));
      if (delErr) throw delErr;
    }
    const { data: dnItems } = await c.from('delivery_note_items')
      .select('id,item_code,roshen_id,po_item_id').eq('dn_id', inv.deliveryNoteId);
    (dnItems || []).forEach((r) => {
      const k = keyOf(r.roshen_id, r.item_code);
      if (k) { dnItemIdx[k] = r.id; poItemIdx[k] = r.po_item_id; }
    });
  }

  const { data: invRow, error: e1 } = await c.from('supplier_invoices').insert({
    order_id: inv.orderId,
    delivery_note_id: inv.deliveryNoteId || null,
    invoice_number: inv.header.invoice_number || ('INV-' + Date.now()),
    invoice_date: inv.header.invoice_date || null,
    supplier: inv.header.supplier || null,
    buyer: inv.header.buyer || null,
    currency: inv.header.currency || 'SAR',
    dn_reference: inv.header.dn_reference || null,
    total_taxable, total_vat, grand_total: grand,
    status: inv.status || 'Imported',
    source_type: 'pdf',
    document_name: inv.document && inv.document.name,
    source_filename: inv.document && inv.document.name,
    extracted: inv.extracted || null,
    validation_summary: inv.validation || null,
    match_summary: inv.validation || null,
    created_by: inv.createdBy || null,
  }).select().single();
  if (e1) {
    if (e1.code === '23505') throw new Error('An invoice with this number already exists for this purchase order. Check the invoice number before saving.');
    throw e1;
  }

  const cleanup = async (msg, err) => { await c.from('supplier_invoices').delete().eq('id', invRow.id); throw new Error(msg + (err && (err.message || err) ? ': ' + (err.message || err) : '')); };

  // attach the original PDF (audit). Failing loud keeps the record honest — no
  // invoice is stored claiming an attachment it does not have.
  const hasDoc = !!(inv.document && inv.document.base64);
  if (hasDoc) {
    try { await saveInvoiceDocument(invRow.id, inv.orderId, { ...inv.document, createdBy: inv.createdBy }); }
    catch (e) { return cleanup('Could not store the invoice PDF', e); }
  }
  {
    const { error } = await c.from('supplier_invoices').update({ document_path: hasDoc ? 'db:supplier_invoice_documents' : null }).eq('id', invRow.id);
    if (error) return cleanup('Could not finalise the invoice', error);
  }

  const rows = lines.map((l) => {
    const key = keyOf(l.roshen_id, l.item_code);
    return {
      invoice_id: invRow.id, dn_item_id: key ? (dnItemIdx[key] || null) : null, po_item_id: key ? (poItemIdx[key] || null) : null,
      item_code: l.item_code || null, roshen_id: l.roshen_id || null, description: l.description || null, uom: l.uom || null,
      invoiced_cases: l.invoiced_cases || 0, case_price: l.case_price != null ? l.case_price : null,
      taxable_amount: l.taxable_amount != null ? l.taxable_amount : null,
      vat_percent: l.vat_percent != null ? l.vat_percent : null,
      vat_amount: l.vat_amount != null ? l.vat_amount : null,
      line_total: l.line_total != null ? l.line_total : null,
      match_status: key ? 'bound' : 'unbound',
    };
  });
  if (rows.length) {
    const { error: e2 } = await c.from('supplier_invoice_items').insert(rows);
    if (e2) return cleanup('Could not store the invoice lines', e2);
  }
  return invRow;
}

// Re-validate the stored invoice against its delivery note at the VALUE level
// (invoice net vs DN expected net) plus DN/PO reference identity — the same
// engine the upload screen uses. Sets Matched (unlocks receiving) or Disputed.
export async function matchInvoiceToDeliveryNote(invoiceId) {
  const c = getClient();
  const inv = await getInvoice(invoiceId);
  if (!inv.delivery_note_id) throw new Error('Invoice is not linked to a delivery note.');

  const ctx = await deliveryNoteMatchContext(inv.delivery_note_id);
  const poRef = inv.extracted && inv.extracted.header ? inv.extracted.header.po_reference : null;
  const parsedLike = {
    header: { dn_reference: inv.dn_reference, po_reference: poRef },
    totals: { taxable: inv.total_taxable, vat: inv.total_vat, grand: inv.grand_total },
    lines: inv.items || [],
  };
  const cmp = compareInvoiceToDeliveryNote(parsedLike, ctx);
  const status = cmp.ok ? 'Matched' : 'Disputed';
  const { error } = await c.from('supplier_invoices')
    .update({ status, match_summary: cmp, validation_summary: cmp, updated_at: new Date().toISOString() }).eq('id', invoiceId);
  if (error) throw error;
  return { status, summary: cmp, matched: cmp.ok };
}

// A DN is invoice-gated: exactly one matched invoice unlocks goods receiving.
export async function deliveryNoteHasMatchedInvoice(deliveryNoteId) {
  const { data, error } = await getClient().from('supplier_invoices')
    .select('id,status').eq('delivery_note_id', deliveryNoteId).eq('status', 'Matched');
  if (error) throw error;
  return (data || []).length > 0;
}
