// Supplier-Invoice service — the supplier invoice is RECEIVED as the supplier's
// own document (PDF now, ZATCA XML later). It is uploaded, its data extracted,
// stored with the original file for audit, and validated against the Delivery
// Note. Each DN needs exactly one matched invoice before its Goods Receipt can
// be released.
import { getClient, one } from '../supabase/client.js';
import { lineKey as keyOf } from '../../utils/format.js';
import { compareInvoiceToDeliveryNote } from './invoice-compare.js';
import { matchInvoiceLines } from './invoice-line-match.js';

// ---- audit trail (mirrors the delivery-note audit log) --------------
export async function logInvoiceAudit(invoiceId, orderId, action, { detail, note, actor } = {}) {
  const { error } = await getClient().from('supplier_invoice_audit_log').insert({
    invoice_id: invoiceId, order_id: orderId || null, action, detail: detail || null, note: note || null, actor: actor || null,
  });
  if (error) throw error;
}
export async function listInvoiceAudit(invoiceId) {
  const { data, error } = await getClient().from('supplier_invoice_audit_log')
    .select('*').eq('invoice_id', invoiceId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

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

  // Multiple invoices per delivery note are allowed (partial invoicing). We
  // only resolve the DN/PO line ids so each invoice line stays traceable;
  // replacing a prior invoice is now an explicit, audited action.
  const dnItemIdx = {}, poItemIdx = {};
  if (inv.deliveryNoteId) {
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
    doc_type: inv.docType || 'invoice',
    parent_invoice_id: inv.parentInvoiceId || null,
    invoice_number: inv.header.invoice_number || ('INV-' + Date.now()),
    invoice_date: inv.header.invoice_date || null,
    supply_date: inv.header.supply_date || null,
    supplier: inv.header.supplier || null,
    buyer: inv.header.buyer || null,
    currency: inv.header.currency || 'SAR',
    dn_reference: inv.header.dn_reference || null,
    zatca: inv.zatca || null,
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

  const rows = lines.map((l, i) => {
    const key = keyOf(l.roshen_id, l.item_code);
    return {
      invoice_id: invRow.id, line_no: l.line_no != null ? l.line_no : i + 1,
      dn_item_id: key ? (dnItemIdx[key] || null) : null, po_item_id: key ? (poItemIdx[key] || null) : null,
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
  try {
    await logInvoiceAudit(invRow.id, inv.orderId, inv.docType === 'credit_note' ? 'credit_note' : inv.docType === 'debit_note' ? 'debit_note' : 'created',
      { detail: { invoice_number: invRow.invoice_number, doc_type: invRow.doc_type, lines: rows.length, status: invRow.status }, actor: inv.createdBy });
  } catch (e) { /* audit best-effort */ }
  // Persist line-level reconciliation immediately for a bound, DN-linked tax
  // invoice (credit/debit notes are adjustments, not matched against delivery).
  if (inv.deliveryNoteId && (inv.docType || 'invoice') === 'invoice') {
    try { await matchInvoiceLineLevel(invRow.id, { actor: inv.createdBy, keepStatus: true }); } catch (e) { /* best-effort */ }
  }
  return invRow;
}

// ---- line-level reconciliation --------------------------------------
async function fulfillmentRows(orderId) {
  const { data, error } = await getClient().from('po_line_fulfillment').select('*').eq('order_id', orderId);
  if (error) throw error;
  return data || [];
}

// Billable baseline per PO line for one invoice: delivered cases at the PO
// price, net of what OTHER (non-cancelled, non-replaced) invoices already
// billed — so partial invoicing across several invoices reconciles correctly.
export async function invoiceExpectedBaseline(orderId, excludeInvoiceId) {
  const ful = await fulfillmentRows(orderId);
  const selfContribution = {};
  if (excludeInvoiceId) {
    const { data } = await getClient().from('supplier_invoice_items')
      .select('roshen_id,item_code,invoiced_cases').eq('invoice_id', excludeInvoiceId);
    (data || []).forEach((r) => { const k = keyOf(r.roshen_id, r.item_code); if (k) selfContribution[k] = (selfContribution[k] || 0) + Number(r.invoiced_cases || 0); });
  }
  return ful.map((r) => {
    const k = keyOf(r.roshen_id, r.item_code);
    const invoicedTotal = Number(r.invoiced_cases || 0);
    return {
      roshen_id: r.roshen_id, item_code: r.item_code, description: r.description,
      delivered_cases: Number(r.delivered_cases || 0),
      already_invoiced_cases: Math.max(0, invoicedTotal - (selfContribution[k] || 0)),
      po_price: Number(r.price_case || 0),
    };
  });
}

// Reconcile an invoice line-by-line against PO↔DN, persist per-line variances
// and match_status, and (unless keepStatus) set the header status:
//   Matched (clean full match) · Partially Matched (clean but lines still open)
//   · Disputed (hard qty/price/tax variances or extra lines).
export async function matchInvoiceLineLevel(invoiceId, { actor, keepStatus = false } = {}) {
  const c = getClient();
  const inv = await getInvoice(invoiceId);
  const expected = await invoiceExpectedBaseline(inv.order_id, invoiceId);
  const result = matchInvoiceLines(expected, inv.items || []);

  const byKey = {};
  (inv.items || []).forEach((it) => { const k = keyOf(it.roshen_id, it.item_code); if (k && byKey[k] == null) byKey[k] = it.id; });
  for (const l of result.lines) {
    if (l.kind === 'missing') continue;              // open PO line, no invoice item to stamp
    const itemId = l.key ? byKey[l.key] : null;
    if (!itemId) continue;
    const { error } = await c.from('supplier_invoice_items').update({
      match_status: l.kind,
      expected_cases: l.expected_cases != null ? l.expected_cases : null,
      expected_case_price: l.expected_case_price != null ? l.expected_case_price : null,
      qty_variance: l.qty_variance != null ? l.qty_variance : null,
      price_variance: l.price_variance != null ? l.price_variance : null,
      tax_variance: l.tax_variance != null ? l.tax_variance : null,
    }).eq('id', itemId);
    if (error) throw error;
  }

  const status = result.summary.ok ? 'Matched' : result.summary.okPartial ? 'Partially Matched' : 'Disputed';
  const patch = { match_summary: result.summary, validation_summary: result.summary, updated_at: new Date().toISOString() };
  if (!keepStatus && inv.doc_type === 'invoice' && !['Cancelled', 'Replaced'].includes(inv.status)) patch.status = status;
  const { error } = await c.from('supplier_invoices').update(patch).eq('id', invoiceId);
  if (error) throw error;
  if (!keepStatus) { try { await logInvoiceAudit(invoiceId, inv.order_id, status === 'Disputed' ? 'disputed' : 'matched', { detail: result.summary, actor }); } catch (e) { /* best-effort */ } }
  return { status: patch.status || inv.status, result, matched: result.summary.ok, partial: result.summary.okPartial && !result.summary.ok };
}

// ---- edit / cancel / replace / adjustment notes ---------------------
const releasedGrForDn = async (dnId) => {
  if (!dnId) return false;
  const { data, error } = await getClient().from('goods_receipts').select('status').eq('delivery_note_id', dnId);
  if (error) throw error;
  return (data || []).some((g) => ['Released', 'Partially Released'].includes(g.status));
};

function invoiceSnapshot(inv) {
  return {
    status: inv.status, invoice_number: inv.invoice_number, invoice_date: inv.invoice_date, doc_type: inv.doc_type,
    total_taxable: inv.total_taxable, total_vat: inv.total_vat, grand_total: inv.grand_total,
    lines: (inv.items || []).map((l) => ({ roshen_id: l.roshen_id, item_code: l.item_code, invoiced_cases: l.invoiced_cases, case_price: l.case_price, taxable_amount: l.taxable_amount, vat_amount: l.vat_amount })),
  };
}

async function resolveDnPoIdx(deliveryNoteId) {
  const idx = { dnItemIdx: {}, poItemIdx: {} };
  if (!deliveryNoteId) return idx;
  const { data } = await getClient().from('delivery_note_items').select('id,item_code,roshen_id,po_item_id').eq('dn_id', deliveryNoteId);
  (data || []).forEach((r) => { const k = keyOf(r.roshen_id, r.item_code); if (k) { idx.dnItemIdx[k] = r.id; idx.poItemIdx[k] = r.po_item_id; } });
  return idx;
}

async function insertInvoiceLines(invoiceId, idx, lines) {
  const rows = (lines || []).map((l, i) => {
    const key = keyOf(l.roshen_id, l.item_code);
    return {
      invoice_id: invoiceId, line_no: l.line_no != null ? l.line_no : i + 1,
      dn_item_id: key ? (idx.dnItemIdx[key] || null) : null, po_item_id: key ? (idx.poItemIdx[key] || null) : null,
      item_code: l.item_code || null, roshen_id: l.roshen_id || null, description: l.description || null, uom: l.uom || null,
      invoiced_cases: l.invoiced_cases || 0, case_price: l.case_price != null ? l.case_price : null,
      taxable_amount: l.taxable_amount != null ? l.taxable_amount : null,
      vat_percent: l.vat_percent != null ? l.vat_percent : null,
      vat_amount: l.vat_amount != null ? l.vat_amount : null,
      line_total: l.line_total != null ? l.line_total : null,
      match_status: key ? 'bound' : 'unbound',
    };
  });
  if (rows.length) { const { error } = await getClient().from('supplier_invoice_items').insert(rows); if (error) throw error; }
}

const sum2 = (arr, f) => +(arr || []).reduce((a, x) => a + Number(f(x) || 0), 0).toFixed(2);

// Edit an invoice header / lines. Blocked once goods have been received against
// its delivery note, or if it is a credit/debit note (issue a new note instead).
export async function editSupplierInvoice(invoiceId, { header, lines }, actor) {
  const c = getClient();
  const inv = await getInvoice(invoiceId);
  if (['Cancelled', 'Replaced'].includes(inv.status)) throw new Error(`Cannot edit a ${inv.status.toLowerCase()} invoice.`);
  if (inv.doc_type !== 'invoice') throw new Error('Credit and debit notes cannot be edited — issue a new adjustment note instead.');
  if (await releasedGrForDn(inv.delivery_note_id)) throw new Error('Cannot edit — goods have already been received against this delivery note. Reverse the goods receipt first.');
  const before = invoiceSnapshot(inv);

  const patch = { updated_at: new Date().toISOString() };
  if (header) ['invoice_number', 'invoice_date', 'supply_date', 'supplier', 'buyer', 'currency', 'dn_reference'].forEach((k) => { if (header[k] !== undefined) patch[k] = header[k]; });
  if (header && header.zatca !== undefined) patch.zatca = header.zatca;
  if (lines) {
    patch.total_taxable = sum2(lines, (l) => l.taxable_amount);
    patch.total_vat = sum2(lines, (l) => l.vat_amount);
    patch.grand_total = +(patch.total_taxable + patch.total_vat).toFixed(2);
  }
  const { error: eH } = await c.from('supplier_invoices').update(patch).eq('id', invoiceId);
  if (eH) { if (eH.code === '23505') throw new Error('Another active invoice already uses this number on this purchase order.'); throw eH; }

  if (lines) {
    const { error: eDel } = await c.from('supplier_invoice_items').delete().eq('invoice_id', invoiceId);
    if (eDel) throw eDel;
    await insertInvoiceLines(invoiceId, await resolveDnPoIdx(inv.delivery_note_id), lines);
  }
  const reMatch = await matchInvoiceLineLevel(invoiceId, { actor, keepStatus: false });
  const after = invoiceSnapshot(await getInvoice(invoiceId));
  await logInvoiceAudit(invoiceId, inv.order_id, 'edited', { detail: { before, after, match: reMatch.result.summary }, actor });
  return { edited: true, status: reMatch.status };
}

// Cancel an invoice (removed from the invoiced ledger — the view excludes it).
export async function cancelSupplierInvoice(invoiceId, { reason, actor } = {}) {
  const inv = await getInvoice(invoiceId);
  if (inv.status === 'Cancelled') return { cancelled: true };
  if (inv.doc_type === 'invoice' && await releasedGrForDn(inv.delivery_note_id)) {
    throw new Error('Cannot cancel — goods already received against this delivery note. Reverse the goods receipt first.');
  }
  const { error } = await getClient().from('supplier_invoices')
    .update({ status: 'Cancelled', updated_at: new Date().toISOString() }).eq('id', invoiceId);
  if (error) throw error;
  await logInvoiceAudit(invoiceId, inv.order_id, 'cancelled', { note: reason, actor });
  return { cancelled: true };
}

// Supersede an invoice with a corrected one (both kept for audit): the original
// becomes Replaced and points at its replacement.
export async function supersedeInvoice(oldInvoiceId, newInvoiceId, { reason, actor } = {}) {
  const oldInv = await getInvoice(oldInvoiceId);
  if (oldInv.doc_type === 'invoice' && await releasedGrForDn(oldInv.delivery_note_id)) {
    throw new Error('Cannot replace — goods already received against this delivery note. Reverse the goods receipt first.');
  }
  const { error } = await getClient().from('supplier_invoices')
    .update({ status: 'Replaced', superseded_by: newInvoiceId, updated_at: new Date().toISOString() }).eq('id', oldInvoiceId);
  if (error) throw error;
  await getClient().from('supplier_invoices').update({ parent_invoice_id: oldInvoiceId }).eq('id', newInvoiceId);
  await logInvoiceAudit(oldInvoiceId, oldInv.order_id, 'replaced', { note: reason, detail: { superseded_by: newInvoiceId }, actor });
  return { replaced: true };
}

// Issue a credit or debit note against an invoice. Lines carry SIGNED cases /
// amounts (a credit note reduces the invoiced balance, a debit note increases
// it) — the fulfillment ledger nets them automatically.
export async function createAdjustmentNote(parentInvoiceId, { docType, header, lines, totals, reason, actor } = {}) {
  if (!['credit_note', 'debit_note'].includes(docType)) throw new Error('Adjustment note type must be credit_note or debit_note.');
  const parent = await getInvoice(parentInvoiceId);
  const note = await createSupplierInvoiceFromUpload({
    orderId: parent.order_id, deliveryNoteId: parent.delivery_note_id,
    docType, parentInvoiceId,
    header: header || {}, totals, lines: lines || [],
    zatca: header && header.zatca, extracted: null, validation: { adjustment: true, reason },
    status: 'Matched', createdBy: actor,
  });
  await logInvoiceAudit(parentInvoiceId, parent.order_id, docType, { note: reason, detail: { note_id: note.id, number: note.invoice_number, grand_total: note.grand_total }, actor });
  return note;
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
