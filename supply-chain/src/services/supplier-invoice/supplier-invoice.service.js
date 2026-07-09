// Supplier-Invoice service — the supplier invoice is RECEIVED as the supplier's
// own document (PDF now, ZATCA XML later). It is uploaded, its data extracted,
// stored with the original file for audit, and validated against the Delivery
// Note. Each DN needs exactly one matched invoice before its Goods Receipt can
// be released.
import { getClient, one } from '../supabase/client.js';
import { approxEq } from '../../utils/format.js';

const keyOf = (roshen, code) => String(roshen || '').trim() || String(code || '').trim();

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

// Prefill invoice lines from a DN's delivered cases × PO case price (pure).
// dnItems: [{roshen_id,item_code,description,uom, batches:[{cases}]}]
// priceByKey: { line_key: case_price }
export function invoiceLinesFromDeliveryNote(dnItems, priceByKey = {}) {
  return dnItems.map((it) => {
    const key = keyOf(it.roshen_id, it.item_code);
    const cases = (it.batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    const price = Number(priceByKey[key] || 0);
    const taxable = +(cases * price).toFixed(2);
    const vat = +(taxable * 0.15).toFixed(2);
    return {
      roshen_id: it.roshen_id, item_code: it.item_code, description: it.description, uom: it.uom,
      invoiced_cases: cases, case_price: price,
      taxable_amount: taxable, vat_percent: 15, vat_amount: vat, line_total: +(taxable + vat).toFixed(2),
    };
  });
}

// inv: { orderId, deliveryNoteId, header:{invoice_number,invoice_date,supplier,currency,source_filename},
//        lines:[...], createdBy }
export async function createSupplierInvoice(inv) {
  const c = getClient();
  const lines = inv.lines || [];
  const total_taxable = +lines.reduce((a, l) => a + Number(l.taxable_amount || 0), 0).toFixed(2);
  const total_vat = +lines.reduce((a, l) => a + Number(l.vat_amount || 0), 0).toFixed(2);

  // resolve DN-line / PO-line ids for traceability
  const dnItemIdx = {}, poItemIdx = {};
  if (inv.deliveryNoteId) {
    const { data: dnItems } = await c.from('delivery_note_items')
      .select('id,item_code,roshen_id,po_item_id').eq('dn_id', inv.deliveryNoteId);
    (dnItems || []).forEach((r) => {
      dnItemIdx[keyOf(r.roshen_id, r.item_code)] = r.id;
      poItemIdx[keyOf(r.roshen_id, r.item_code)] = r.po_item_id;
    });
  }

  const { data: invRow, error: e1 } = await c.from('supplier_invoices').insert({
    order_id: inv.orderId,
    delivery_note_id: inv.deliveryNoteId || null,
    invoice_number: inv.header.invoice_number || ('INV-' + Date.now()),
    invoice_date: inv.header.invoice_date || null,
    supplier: inv.header.supplier || null,
    currency: inv.header.currency || 'SAR',
    total_taxable, total_vat, grand_total: +(total_taxable + total_vat).toFixed(2),
    status: 'Imported',
    source_filename: inv.header.source_filename || null,
    created_by: inv.createdBy || null,
  }).select().single();
  if (e1) throw e1;

  const rows = lines.map((l) => {
    const key = keyOf(l.roshen_id, l.item_code);
    return {
      invoice_id: invRow.id,
      dn_item_id: dnItemIdx[key] || null,
      po_item_id: poItemIdx[key] || null,
      item_code: l.item_code || null, roshen_id: l.roshen_id || null, description: l.description || null, uom: l.uom || null,
      invoiced_cases: l.invoiced_cases || 0, case_price: l.case_price != null ? l.case_price : null,
      taxable_amount: l.taxable_amount != null ? l.taxable_amount : null,
      vat_percent: l.vat_percent != null ? l.vat_percent : null,
      vat_amount: l.vat_amount != null ? l.vat_amount : null,
      line_total: l.line_total != null ? l.line_total : null,
    };
  });
  if (rows.length) {
    const { error: e2 } = await c.from('supplier_invoice_items').insert(rows);
    if (e2) throw e2;
  }
  return invRow;
}

// Create an invoice from an uploaded supplier document (PDF). Stores the header,
// the extracted payload + validation outcome, the original file path for audit,
// and the (user-verified, SKU-bound) line items. `status` is decided by the
// validation screen: Matched unlocks goods receiving, Disputed does not.
// inv: { orderId, deliveryNoteId, header:{invoice_number,invoice_date,supplier,buyer,po_reference,dn_reference,currency},
//        totals:{taxable,vat,grand}, lines:[{roshen_id,item_code,description,invoiced_cases,case_price,
//        taxable_amount,vat_percent,vat_amount,line_total}], document:{path,name}, extracted, validation, status, createdBy }
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
    const { data: dnItems } = await c.from('delivery_note_items')
      .select('id,item_code,roshen_id,po_item_id').eq('dn_id', inv.deliveryNoteId);
    (dnItems || []).forEach((r) => { dnItemIdx[keyOf(r.roshen_id, r.item_code)] = r.id; poItemIdx[keyOf(r.roshen_id, r.item_code)] = r.po_item_id; });
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
  if (e1) throw e1;

  // attach the original PDF (audit) once we have the invoice id
  if (inv.document && inv.document.base64) {
    try { await saveInvoiceDocument(invRow.id, inv.orderId, { ...inv.document, createdBy: inv.createdBy }); }
    catch (e) { /* invoice is saved; document attach is best-effort */ }
  }
  // record whether an original document is attached
  await getClient().from('supplier_invoices')
    .update({ document_path: inv.document && inv.document.base64 ? 'db:supplier_invoice_documents' : null }).eq('id', invRow.id);

  const rows = lines.map((l) => {
    const key = keyOf(l.roshen_id, l.item_code);
    return {
      invoice_id: invRow.id, dn_item_id: dnItemIdx[key] || null, po_item_id: poItemIdx[key] || null,
      item_code: l.item_code || null, roshen_id: l.roshen_id || null, description: l.description || null, uom: l.uom || null,
      invoiced_cases: l.invoiced_cases || 0, case_price: l.case_price != null ? l.case_price : null,
      taxable_amount: l.taxable_amount != null ? l.taxable_amount : null,
      vat_percent: l.vat_percent != null ? l.vat_percent : null,
      vat_amount: l.vat_amount != null ? l.vat_amount : null,
      line_total: l.line_total != null ? l.line_total : null,
      match_status: l.roshen_id || l.item_code ? 'bound' : 'unbound',
    };
  });
  if (rows.length) {
    const { error: e2 } = await c.from('supplier_invoice_items').insert(rows);
    if (e2) throw e2;
  }
  return invRow;
}

// Compare invoice lines to the DN delivered cases; set Matched or Disputed.
export async function matchInvoiceToDeliveryNote(invoiceId) {
  const c = getClient();
  const inv = await getInvoice(invoiceId);
  if (!inv.delivery_note_id) throw new Error('Invoice is not linked to a delivery note.');

  const { data: dnItems, error } = await c.from('delivery_note_items')
    .select('item_code,roshen_id, delivery_note_batches(cases)').eq('dn_id', inv.delivery_note_id);
  if (error) throw error;
  const dnByKey = {};
  (dnItems || []).forEach((it) => {
    dnByKey[keyOf(it.roshen_id, it.item_code)] = (it.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
  });

  let mismatches = 0;
  const rows = inv.items.map((l) => {
    const dnCases = dnByKey[keyOf(l.roshen_id, l.item_code)];
    const ok = dnCases != null && approxEq(dnCases, l.invoiced_cases, 0.01);
    if (!ok) mismatches++;
    return { key: keyOf(l.roshen_id, l.item_code), invoiced: l.invoiced_cases, delivered: dnCases == null ? null : dnCases, ok };
  });
  const status = mismatches === 0 ? 'Matched' : 'Disputed';
  const summary = { mismatches, lines: rows, matched: status === 'Matched' };

  const { error: e2 } = await c.from('supplier_invoices')
    .update({ status, match_summary: summary, updated_at: new Date().toISOString() }).eq('id', invoiceId);
  if (e2) throw e2;
  return { status, summary };
}

// A DN is invoice-gated: exactly one matched invoice unlocks goods receiving.
export async function deliveryNoteHasMatchedInvoice(deliveryNoteId) {
  const { data, error } = await getClient().from('supplier_invoices')
    .select('id,status').eq('delivery_note_id', deliveryNoteId).eq('status', 'Matched');
  if (error) throw error;
  return (data || []).length > 0;
}
