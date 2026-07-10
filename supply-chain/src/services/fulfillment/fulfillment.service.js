// Fulfillment service — reads the derived per-PO-line ledger and drives the
// financial completion steps (Invoice Matched / Financially Closed) that the DB
// never applies automatically.
import { getClient } from '../supabase/client.js';
import { lineKey as keyOf } from '../../utils/format.js';

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

// ---- PI operational dashboard -----------------------------------------
// One call that makes the PI the single screen of record for receiving: every
// line with ordered / received / remaining / completion %, DN + GR counts,
// last receipt date, an Open / Partial / Completed status, and a drill-down
// of the linked delivery notes, goods receipts and received batches.
export async function getReceivingDashboard(orderId) {
  const c = getClient();
  const [fulRows, dnQ, grQ] = await Promise.all([
    getFulfillment(orderId),
    c.from('delivery_notes')
      .select('id,dn_number,dn_date,imported_at,status,expected_delivery_at, supplier_invoices(status,doc_type), delivery_note_items(item_code,roshen_id, delivery_note_batches(cases))')
      .eq('order_id', orderId),
    c.from('goods_receipts')
      .select('id,grn_number,receipt_date,status,released_at,warehouse, goods_receipt_batches(id,item_code,roshen_id,batch_no,expiry_date,received_cases,qc_result,batch_id)')
      .eq('order_id', orderId),
  ]);
  if (dnQ.error) throw dnQ.error;
  if (grQ.error) throw grQ.error;
  const dns = (dnQ.data || []).filter((d) => !['Cancelled', 'Reversed'].includes(d.status));
  const grs = (grQ.data || []).filter((g) => g.status !== 'Cancelled');

  // live batch stock for the received-batches drill-down (one query)
  const batchIds = grs.flatMap((g) => (g.goods_receipt_batches || []).map((b) => b.batch_id)).filter(Boolean);
  const stockById = {};
  if (batchIds.length) {
    const { data: st } = await c.from('batch_stock').select('id,current_cases,qc_status,hold_status').in('id', batchIds);
    (st || []).forEach((s) => { stockById[s.id] = s; });
  }

  const byKey = {};
  const bucket = (k) => (byKey[k] = byKey[k] || { dns: new Map(), grs: new Map(), batches: [], lastReceipt: null });

  dns.forEach((d) => {
    // active tax-invoice status for this DN (adjustment notes don't count)
    const invs = (Array.isArray(d.supplier_invoices) ? d.supplier_invoices : (d.supplier_invoices ? [d.supplier_invoices] : []))
      .filter((i) => (i.doc_type == null || i.doc_type === 'invoice') && !['Cancelled', 'Replaced'].includes(i.status));
    const invStatus = invs.some((i) => i.status === 'Matched') ? 'Matched'
      : invs.some((i) => i.status === 'Partially Matched') ? 'Partially Matched'
      : invs.some((i) => i.status === 'Disputed') ? 'Disputed'
      : invs.length ? 'Imported' : 'No invoice';
    (d.delivery_note_items || []).forEach((it) => {
      const k = keyOf(it.roshen_id, it.item_code);
      if (!k) return;
      const cases = (it.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
      if (!cases) return;
      const b = bucket(k);
      const prev = b.dns.get(d.id) || { id: d.id, dn_number: d.dn_number, dn_date: d.dn_date, imported_at: d.imported_at, status: d.status, expected_delivery_at: d.expected_delivery_at, invoice_status: invStatus, cases: 0 };
      prev.cases = +(prev.cases + cases).toFixed(2);
      b.dns.set(d.id, prev);
    });
  });
  grs.forEach((g) => {
    (g.goods_receipt_batches || []).forEach((gb) => {
      const k = keyOf(gb.roshen_id, gb.item_code);
      if (!k) return;
      const b = bucket(k);
      const released = gb.qc_result === 'Released' && ['Released', 'Partially Released'].includes(g.status);
      const prev = b.grs.get(g.id) || { id: g.id, grn_number: g.grn_number, receipt_date: g.receipt_date, status: g.status, released_at: g.released_at, warehouse: g.warehouse, cases: 0 };
      prev.cases = +(prev.cases + (released ? Number(gb.received_cases || 0) : 0)).toFixed(2);
      b.grs.set(g.id, prev);
      if (released) {
        const st = gb.batch_id ? stockById[gb.batch_id] : null;
        b.batches.push({ batch_id: gb.batch_id, batch_no: gb.batch_no, expiry_date: gb.expiry_date,
          received_cases: Number(gb.received_cases || 0), qc_result: gb.qc_result,
          current_cases: st ? Number(st.current_cases) : null, hold_status: st ? st.hold_status : null,
          grn_number: g.grn_number });
        if (g.released_at && (!b.lastReceipt || g.released_at > b.lastReceipt)) b.lastReceipt = g.released_at;
      }
    });
  });

  const rows = annotate(fulRows).map((r) => {
    const k = keyOf(r.roshen_id, r.item_code);
    const b = byKey[k] || { dns: new Map(), grs: new Map(), batches: [], lastReceipt: null };
    const lineDns = [...b.dns.values()];
    const ordered = Number(r.ordered_cases || 0), received = Number(r.received_cases || 0);
    const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0;
    const lineStatus = received <= 0 ? 'Not Started' : received >= ordered - 0.0001 ? 'Completed' : 'Partial';
    const lastDelivery = lineDns.map((d) => d.dn_date || String(d.imported_at || '').slice(0, 10)).filter(Boolean).sort().pop() || null;

    // invoice status across the line's DNs (worst outstanding state wins)
    const invStatuses = lineDns.map((d) => d.invoice_status);
    const invoiceStatus = !lineDns.length ? '—'
      : invStatuses.includes('Disputed') ? 'Disputed'
      : invStatuses.includes('No invoice') ? 'No invoice'
      : invStatuses.includes('Imported') ? 'Pending'
      : invStatuses.includes('Partially Matched') ? 'Partially Matched' : 'Matched';

    // shipment status: the most advanced in-flight DN stage
    const open = lineDns.filter((d) => d.status !== 'Received');
    const shipmentStatus = !lineDns.length ? '—'
      : !open.length ? 'Received'
      : open.some((d) => d.status === 'In Transit') ? 'In Transit'
      : open.some((d) => d.status === 'Ready for Delivery') ? 'Ready for Delivery'
      : open.some((d) => d.status === 'Receiving Review') ? 'Receiving Review' : 'Preparing';

    // earliest ETA among shipments not yet received
    const etas = open.map((d) => d.expected_delivery_at).filter(Boolean).sort();
    const expectedArrival = etas[0] || null;

    const receiptStatus = received <= 0 ? (lineDns.length ? 'Not received' : '—')
      : received >= ordered - 0.0001 ? 'Received' : 'Partially received';

    return { ...r, pct, line_status: lineStatus,
      invoice_status: invoiceStatus, shipment_status: shipmentStatus,
      expected_arrival: expectedArrival, receipt_status: receiptStatus,
      dn_count: b.dns.size, gr_count: b.grs.size,
      last_delivery_at: lastDelivery, last_receipt_at: b.lastReceipt,
      drill: { dns: lineDns, grs: [...b.grs.values()], batches: b.batches } };
  });
  return { rows, summary: summarise(rows) };
}

// ---- Open Orders overview ----------------------------------------------
// Every PI that is not yet completed, with its live totals — so at any moment
// you can see which orders are open, what has arrived, and what is still
// expected from the supplier.
const CLOSED_STATUSES = ['Closed', 'Financially Closed'];
export async function listOpenOrders() {
  const c = getClient();
  const { data: orders, error } = await c.from('supply_orders')
    .select('id,order_number,order_date,supplier,warehouse,expected_arrival,status')
    .not('status', 'in', '("' + CLOSED_STATUSES.join('","') + '")')
    .neq('status', 'Draft')
    .order('order_date', { ascending: false });
  if (error) throw error;
  if (!orders || !orders.length) return [];
  const ids = orders.map((o) => o.id);
  const [{ data: ful }, { data: dns }] = await Promise.all([
    c.from('po_line_fulfillment').select('order_id,ordered_cases,delivered_cases,received_cases').in('order_id', ids),
    c.from('delivery_notes').select('order_id,status,expected_delivery_at').in('order_id', ids),
  ]);
  const agg = {};
  (ful || []).forEach((r) => {
    const a = (agg[r.order_id] = agg[r.order_id] || { ordered: 0, delivered: 0, received: 0 });
    a.ordered += Number(r.ordered_cases || 0); a.delivered += Number(r.delivered_cases || 0); a.received += Number(r.received_cases || 0);
  });
  const eta = {};
  (dns || []).forEach((d) => {
    if (['Cancelled', 'Reversed', 'Received'].includes(d.status) || !d.expected_delivery_at) return;
    if (!eta[d.order_id] || d.expected_delivery_at < eta[d.order_id]) eta[d.order_id] = d.expected_delivery_at;
  });
  return orders.map((o) => {
    const a = agg[o.id] || { ordered: 0, delivered: 0, received: 0 };
    const remaining = +Math.max(0, a.ordered - a.received).toFixed(2);
    const pct = a.ordered > 0 ? Math.min(100, Math.round((a.received / a.ordered) * 100)) : 0;
    return { ...o, ordered_cases: +a.ordered.toFixed(2), delivered_cases: +a.delivered.toFixed(2),
      received_cases: +a.received.toFixed(2), remaining_cases: remaining, pct,
      next_eta: eta[o.id] || null };
  });
}
