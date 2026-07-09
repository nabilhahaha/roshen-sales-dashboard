// Fulfillment service — reads the derived per-PO-line ledger and drives the
// financial completion steps (Invoice Matched / Financially Closed) that the DB
// never applies automatically.
import { getClient } from '../supabase/client.js';

export async function getFulfillment(orderId) {
  const { data, error } = await getClient().from('po_line_fulfillment')
    .select('*').eq('order_id', orderId).order('line_key');
  if (error) throw error;
  return data || [];
}

export function summarise(rows) {
  const s = { ordered: 0, delivered: 0, invoiced: 0, received: 0, open_delivery: 0, open_invoice: 0, open_receipt: 0, lines: rows.length };
  rows.forEach((r) => {
    s.ordered += Number(r.ordered_cases || 0);
    s.delivered += Number(r.delivered_cases || 0);
    s.invoiced += Number(r.invoiced_cases || 0);
    s.received += Number(r.received_cases || 0);
    s.open_delivery += Math.max(0, Number(r.open_delivery || 0));
    s.open_invoice += Math.max(0, Number(r.open_invoice || 0));
    s.open_receipt += Math.max(0, Number(r.open_receipt || 0));
  });
  Object.keys(s).forEach((k) => { if (k !== 'lines') s[k] = +s[k].toFixed(2); });
  s.fullyDelivered = s.open_delivery <= 0.0001 && s.delivered > 0;
  s.fullyReceived = s.open_receipt <= 0.0001 && s.received > 0 && s.fullyDelivered;
  return s;
}

export async function getFulfillmentWithSummary(orderId) {
  const rows = await getFulfillment(orderId);
  return { rows, summary: summarise(rows) };
}

// Explicit financial transitions — never automatic.
export async function markInvoiceMatched(orderId) {
  const { error } = await getClient().from('supply_orders')
    .update({ status: 'Invoice Matched', updated_at: new Date().toISOString() }).eq('id', orderId);
  if (error) throw error;
}
export async function markFinanciallyClosed(orderId) {
  const { error } = await getClient().from('supply_orders')
    .update({ status: 'Financially Closed', updated_at: new Date().toISOString() }).eq('id', orderId);
  if (error) throw error;
}

// case price per line key (for invoice prefill + inventory unit cost)
export async function priceIndex(orderId) {
  const rows = await getFulfillment(orderId);
  const idx = {};
  rows.forEach((r) => { idx[r.line_key] = Number(r.price_case || 0); });
  return idx;
}
