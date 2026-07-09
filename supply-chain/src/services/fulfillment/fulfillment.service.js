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
  const s = { ordered: 0, delivered: 0, invoiced: 0, received: 0, remaining: 0, disputed: 0, open_delivery: 0, open_invoice: 0, open_receipt: 0, lines: rows.length };
  rows.forEach((r) => {
    const ordered = Number(r.ordered_cases || 0), delivered = Number(r.delivered_cases || 0), received = Number(r.received_cases || 0);
    s.ordered += ordered;
    s.delivered += delivered;
    s.invoiced += Number(r.invoiced_cases || 0);
    s.received += received;
    s.remaining += Math.max(0, ordered - received);              // still to receive vs PO
    s.disputed += Math.max(0, delivered - ordered);              // over-delivered excess (disputed)
    s.open_delivery += Math.max(0, Number(r.open_delivery || 0));
    s.open_invoice += Math.max(0, Number(r.open_invoice || 0));
    s.open_receipt += Math.max(0, Number(r.open_receipt || 0));
  });
  Object.keys(s).forEach((k) => { if (k !== 'lines') s[k] = +s[k].toFixed(2); });
  s.fullyDelivered = s.open_delivery <= 0.0001 && s.delivered > 0;
  s.fullyReceived = s.open_receipt <= 0.0001 && s.received > 0 && s.fullyDelivered;
  return s;
}

// Annotate each ledger row with per-line remaining + disputed (over-delivery).
export function annotate(rows) {
  return (rows || []).map((r) => {
    const ordered = Number(r.ordered_cases || 0), delivered = Number(r.delivered_cases || 0), received = Number(r.received_cases || 0);
    return { ...r, remaining_cases: +Math.max(0, ordered - received).toFixed(2), disputed_cases: +Math.max(0, delivered - ordered).toFixed(2) };
  });
}

export async function getFulfillmentWithSummary(orderId) {
  const rows = annotate(await getFulfillment(orderId));
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
