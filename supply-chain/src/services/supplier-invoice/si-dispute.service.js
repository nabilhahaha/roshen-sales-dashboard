// Supplier-invoice dispute service — the same workflow as PO↔PI disputes,
// applied to invoice reconciliation. When a supplier invoice disagrees with the
// PO↔Delivery-Note baseline (quantity, price, tax, missing or extra lines), the
// differences are recorded as OPEN disputes and the invoice is held as Disputed
// (which does not unlock goods receiving). A dispute stays Open until the
// invoice is corrected / replaced / adjusted by a credit or debit note, or the
// user closes it manually.
import { getClient } from '../supabase/client.js';

const round = (v) => +Number(v || 0).toFixed(2);

// Map an engine line kind (or hard-variance flag) to a dispute kind.
const KIND_MAP = { qty_variance: 'qty_diff', price_variance: 'price_diff', tax_variance: 'tax_diff', missing: 'missing', extra: 'extra' };
const HARD = ['qty_variance', 'price_variance', 'tax_variance'];

// Record the disputable lines from a line-level match result. Replaces any
// prior open disputes for the same invoice (re-disputing supersedes).
export async function disputeInvoiceDifferences({ orderId, invoiceId, deliveryNoteId, lines, createdBy }) {
  const c = getClient();
  const disputable = (lines || []).filter((l) => l.kind !== 'matched' && l.kind !== 'partial');
  const recs = [];
  disputable.forEach((l) => {
    const expNet = l.expected_cases != null && l.expected_case_price != null ? Number(l.expected_cases) * Number(l.expected_case_price) : null;
    const base = {
      order_id: orderId, invoice_id: invoiceId || null, delivery_note_id: deliveryNoteId || null,
      item_code: l.item_code || null, roshen_id: l.roshen_id || null, description: l.description || null,
      expected_qty: l.expected_cases != null ? l.expected_cases : null,
      expected_price: l.expected_case_price != null ? l.expected_case_price : null,
      invoiced_qty: l.invoiced_cases != null ? l.invoiced_cases : null,
      invoiced_price: l.case_price != null ? l.case_price : null,
      qty_delta: l.qty_variance != null ? l.qty_variance : null,
      value_delta: l.taxable_amount != null && expNet != null ? round(Number(l.taxable_amount) - expNet) : null,
      tax_delta: l.tax_variance != null ? l.tax_variance : null,
      status: 'Open', created_by: createdBy || null,
    };
    // One dispute per distinct variance on the line (a line can be both
    // over-quantity and wrong-price); missing / extra are single records.
    const hardFlags = (l.flags || []).filter((f) => HARD.includes(f));
    if (hardFlags.length) hardFlags.forEach((f) => recs.push({ ...base, kind: KIND_MAP[f] }));
    else recs.push({ ...base, kind: KIND_MAP[l.kind] || 'qty_diff' });
  });

  await c.from('supplier_invoice_disputes').delete().eq('invoice_id', invoiceId).eq('status', 'Open');
  if (recs.length) { const { error } = await c.from('supplier_invoice_disputes').insert(recs); if (error) throw error; }
  const { error: e2 } = await c.from('supplier_invoices')
    .update({ status: 'Disputed', updated_at: new Date().toISOString() }).eq('id', invoiceId);
  if (e2) throw e2;
  return { disputes: recs.length };
}

export async function listInvoiceDisputes({ orderId, invoiceId, openOnly = false } = {}) {
  let q = getClient().from('supplier_invoice_disputes').select('*').order('created_at', { ascending: false });
  if (invoiceId) q = q.eq('invoice_id', invoiceId);
  if (orderId) q = q.eq('order_id', orderId);
  if (openOnly) q = q.eq('status', 'Open');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function countOpenInvoiceDisputes(orderId) {
  const { count, error } = await getClient().from('supplier_invoice_disputes')
    .select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('status', 'Open');
  if (error) throw error;
  return count || 0;
}

export async function closeInvoiceDispute(id, { resolvedBy, resolution = 'Closed' } = {}) {
  const { error } = await getClient().from('supplier_invoice_disputes')
    .update({ status: 'Resolved', resolution, resolved_by: resolvedBy || null, resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Auto-resolve an invoice's open disputes when it is corrected / replaced /
// adjusted (the correction supersedes the recorded differences).
export async function resolveInvoiceDisputes(invoiceId, { resolvedBy, resolution = 'Corrected' } = {}) {
  const { error } = await getClient().from('supplier_invoice_disputes')
    .update({ status: 'Resolved', resolution, resolved_by: resolvedBy || null, resolved_at: new Date().toISOString() })
    .eq('invoice_id', invoiceId).eq('status', 'Open');
  if (error) throw error;
}
