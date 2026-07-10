// Business Export — complete Excel files for management review, supplier
// discussions and audit. Read-only: gathers what the workflow already stores
// and writes multi-sheet workbooks with the SAME business status model as the
// screens (models/business-status.js).
import { getClient, one } from '../supabase/client.js';
import { buildBusinessTimeline } from '../timeline/business-timeline.service.js';
import { listChainAttachments } from '../attachments/attachments.service.js';
import { orderBusinessStatus, lineBusinessStatus, dnBusinessStatus, siBusinessStatus, dnShipsQuantity } from '../../models/business-status.js';

const XL = () => window.XLSX;
const when = (t) => (t ? String(t).slice(0, 16).replace('T', ' ') : '');

function sheet(wb, name, aoa) {
  XL().utils.book_append_sheet(wb, XL().utils.aoa_to_sheet(aoa), name.slice(0, 31));
}
function save(wb, filename) {
  XL().writeFile(wb, filename.replace(/[/\\:*?"<>|]/g, '-'));
}

// ---- Purchase Order: the complete business file (7 sheets) ----------------
export async function exportOrderBusinessFile(orderId) {
  const c = getClient();
  const [{ data: order }, { data: items }, { data: ful }, { data: dns }, { data: grs }, { data: sis }, timeline, { data: poAudit }] = await Promise.all([
    c.from('supply_orders').select('*').eq('id', orderId).single(),
    c.from('supply_order_items').select('*').eq('order_id', orderId).order('line_no'),
    c.from('po_line_fulfillment').select('*').eq('order_id', orderId).order('line_key'),
    c.from('delivery_notes').select('*, delivery_note_items(item_code,roshen_id, delivery_note_batches(cases))').eq('order_id', orderId).order('dn_number'),
    c.from('goods_receipts').select('*').eq('order_id', orderId).order('id'),
    c.from('supplier_invoices').select('*').eq('order_id', orderId).order('id'),
    buildBusinessTimeline(orderId),
    c.from('po_audit_log').select('*').eq('order_id', orderId).order('created_at'),
  ]);
  if (!order) throw new Error('Order not found');
  const closedManually = !!order.close_reason;

  // shipped cases per line — same single business rule as every screen
  // (dnShipsQuantity): every delivery-note document ships its quantity,
  // only cancelled / reversed notes ship nothing. Never capped: the export
  // reports what the documents say was shipped.
  const shipped = {};
  (dns || []).forEach((d) => {
    if (!dnShipsQuantity(d.status)) return;
    (d.delivery_note_items || []).forEach((it) => {
      const k = String(it.roshen_id || it.item_code);
      shipped[k] = (shipped[k] || 0) + (it.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    });
  });
  const agg = { ordered: 0, shipped: 0, delivered: 0 };
  const fulRows = (ful || []).map((r) => {
    const sh = shipped[String(r.roshen_id || r.item_code)] || 0;
    agg.ordered += Number(r.ordered_cases || 0); agg.shipped += sh; agg.delivered += Number(r.received_cases || 0);
    return { ...r, shipped_cases: sh };
  });
  const biz = orderBusinessStatus(order, agg);
  const pct = agg.ordered ? Math.min(100, Math.round((agg.delivered / agg.ordered) * 100)) : 0;

  const wb = XL().utils.book_new();
  sheet(wb, 'PO Summary', [
    ['PO Number', order.order_number], ['Supplier', order.supplier], ['Warehouse', order.warehouse || ''],
    ['Order Date', order.order_date], ['Expected Arrival', order.expected_arrival || ''],
    ['Business Status', biz], ['Stored Status', order.status],
    ['Ordered Qty (cases)', agg.ordered], ['Shipped Qty', agg.shipped], ['Delivered Qty', agg.delivered],
    ['Remaining Qty', Math.max(0, agg.ordered - agg.delivered)],
    ['Cancelled Qty', closedManually ? Math.max(0, agg.ordered - agg.delivered) : 0],
    ['Delivery Progress %', pct],
    ['Delivery Notes', (dns || []).map((d) => d.dn_number).join(', ')],
    ['Goods Receipts', (grs || []).map((g) => g.grn_number).join(', ')],
    ['Supplier Invoices', (sis || []).map((s) => s.invoice_number).join(', ')],
    ['Close Status', closedManually ? 'Manually Closed' : order.status === 'Closed' ? 'Auto-closed (fully delivered)' : 'Open'],
    ['Close Reason', order.close_reason || ''], ['Close Comments', order.close_comments || ''],
    ['Created By', order.created_by || ''], ['Created Date', when(order.created_at)],
    ['Approved Date', when(order.approved_at)],
    ['Closed By', order.closed_by || ''], ['Closed Date', when(order.closed_at)],
  ]);
  sheet(wb, 'PO Items', [
    ['#', 'Item Code', 'Roshen ID', 'Description', 'UoM', 'Price/Case', 'Ordered', 'Shipped', 'Delivered (received)', 'Remaining', 'Cancelled', 'Line Business Status'],
    ...fulRows.map((r, i) => {
      const remaining = Math.max(0, Number(r.ordered_cases || 0) - Number(r.received_cases || 0));
      return [i + 1, r.item_code, r.roshen_id || '', r.description || '', '', Number(r.price_case || 0),
        Number(r.ordered_cases || 0), r.shipped_cases, Number(r.received_cases || 0), remaining,
        closedManually ? remaining : 0,
        lineBusinessStatus({ ordered: r.ordered_cases, shipped: r.shipped_cases, delivered: r.received_cases }, { closed: closedManually })];
    }),
  ]);
  sheet(wb, 'Delivery Notes', [
    ['DN Number', 'DN Date', 'Stored Status', 'Business Status', 'Cartons', 'Expected Delivery', 'Created By', 'Received By'],
    ...(dns || []).map((d) => [d.dn_number, d.dn_date || '', d.status, dnBusinessStatus(d.status),
      Number(d.total_cartons || 0) || (d.delivery_note_items || []).reduce((a, it) => a + (it.delivery_note_batches || []).reduce((x, b) => x + Number(b.cases || 0), 0), 0),
      when(d.expected_delivery_at), d.created_by || '', d.received_by || '']),
  ]);
  const dnNoById = {}; (dns || []).forEach((d) => { dnNoById[d.id] = d.dn_number; });
  sheet(wb, 'Supplier Invoices', [
    ['Invoice Number', 'Invoice Date', 'Delivery Note', 'Net (taxable)', 'VAT', 'Grand Total', 'Payment Terms', 'Due Date', 'Stored Status', 'Business Status'],
    ...(sis || []).map((s) => [s.invoice_number, s.invoice_date || '', dnNoById[s.delivery_note_id] || s.dn_reference || '',
      Number(s.total_taxable || 0), Number(s.total_vat || 0), Number(s.grand_total || 0), s.payment_terms || '', s.due_date || '',
      s.status, siBusinessStatus(s.status, (dns || []).find((d) => d.id === s.delivery_note_id)?.status)]),
  ]);
  sheet(wb, 'Goods Receipts', [
    ['GRN Number', 'Delivery Note', 'Warehouse', 'Receipt Date', 'Released At', 'Status'],
    ...(grs || []).map((g) => [g.grn_number || ('#' + g.id), dnNoById[g.delivery_note_id] || '', g.warehouse || '', g.receipt_date || '', when(g.released_at), g.status]),
  ]);
  sheet(wb, 'Business Timeline', [
    ['Date & Time', 'Event', 'User', 'Document'],
    ...timeline.map((e) => [when(e.at), e.label, e.user || '', e.doc || '']),
  ]);
  let chainAtts = [];
  try { chainAtts = await listChainAttachments(orderId); } catch (e) { chainAtts = []; }
  sheet(wb, 'Attachments', [
    ['Source Document', 'File Name', 'Uploaded', 'Uploaded By', 'Version'],
    ...chainAtts.map((a) => [a.doc_label, a.filename, when(a.created_at), a.uploaded_by || '', a.revision || 1]),
  ]);
  sheet(wb, 'Audit Trail', [
    ['Date & Time', 'Action', 'Actor', 'Details'],
    ...(poAudit || []).map((a) => [when(a.created_at), a.action, a.actor || '', a.details ? JSON.stringify(a.details) : '']),
  ]);
  save(wb, `PO_${order.order_number}_business_file.xlsx`);
  return true;
}

// ---- Delivery Note export --------------------------------------------------
export async function exportDeliveryNoteExcel(dnId) {
  const c = getClient();
  const { data: dn } = await c.from('delivery_notes')
    .select('*, supply_orders(order_number,status,close_reason), delivery_note_items(*, delivery_note_batches(*)), supplier_invoices(invoice_number,status), goods_receipts(grn_number,status,released_at)')
    .eq('id', dnId).single();
  if (!dn) throw new Error('Delivery note not found');
  const gr = one(dn.goods_receipts);
  let grb = [];
  {
    const { data: grRow } = await c.from('goods_receipts').select('id').eq('delivery_note_id', dnId).limit(1);
    if (grRow && grRow.length) {
      const r = await c.from('goods_receipt_batches').select('dn_batch_id,qc_result,received_cases').eq('gr_id', grRow[0].id);
      grb = r.data || [];
    }
  }
  const qcByDnBatch = {}; (grb || []).forEach((b) => { qcByDnBatch[b.dn_batch_id] = b; });
  const wb = XL().utils.book_new();
  const rows = [];
  (dn.delivery_note_items || []).forEach((it) => (it.delivery_note_batches || []).forEach((b) => {
    const qc = qcByDnBatch[b.id] || {};
    rows.push([it.roshen_id || it.item_code, it.description || '', b.batch_no || '', b.expiry_date || '',
      Number(b.cases || 0), qc.received_cases != null ? Number(qc.received_cases) : '',
      b.remaining_shelf_pct != null ? Number(b.remaining_shelf_pct) : '', qc.qc_result || b.qc_status || '']);
  }));
  sheet(wb, 'Delivery Note', [
    ['Delivery Note', dn.dn_number], ['Date', dn.dn_date || ''], ['Purchase Order', (one(dn.supply_orders) || {}).order_number || dn.po_reference || ''],
    ['Stored Status', dn.status], ['Business Status', dnBusinessStatus(dn.status)],
    ['Goods Receipt', gr ? `${gr.grn_number} (${gr.status})` : ''],
    ['Supplier Invoices', (dn.supplier_invoices || []).map((s) => `${s.invoice_number} (${s.status})`).join(', ')],
    [],
    ['Item', 'Description', 'Batch', 'Expiry', 'Delivered Qty', 'Received Qty', 'Shelf Life %', 'QC Result'],
    ...rows,
  ]);
  save(wb, `DN_${dn.dn_number}.xlsx`);
  return true;
}

// ---- Supplier Invoices export ----------------------------------------------
export async function exportSupplierInvoicesExcel() {
  const c = getClient();
  const { data: sis } = await c.from('supplier_invoices')
    .select('*, supply_orders(order_number), delivery_notes(dn_number,status)').order('created_at');
  const wb = XL().utils.book_new();
  sheet(wb, 'Supplier Invoices', [
    ['Invoice Number', 'Invoice Date', 'Purchase Order', 'Delivery Note', 'Net (taxable)', 'VAT', 'Grand Total', 'Payment Terms', 'Due Date', 'Matched Status', 'Business Status'],
    ...(sis || []).map((s) => [s.invoice_number, s.invoice_date || '', (one(s.supply_orders) || {}).order_number || '',
      (one(s.delivery_notes) || {}).dn_number || s.dn_reference || '',
      Number(s.total_taxable || 0), Number(s.total_vat || 0), Number(s.grand_total || 0),
      s.payment_terms || '', s.due_date || '', s.status, siBusinessStatus(s.status, (one(s.delivery_notes) || {}).status)]),
  ]);
  save(wb, 'Supplier_Invoices.xlsx');
  return true;
}

// ---- Open Orders export ------------------------------------------------------
export async function exportOpenOrdersExcel(overviewRows) {
  const wb = XL().utils.book_new();
  sheet(wb, 'Open Orders', [
    ['PO Number', 'Supplier', 'Order Date', 'Ordered', 'Shipped', 'Delivered', 'Remaining', 'Business Status', 'Progress %', 'Last Activity', 'Expected Arrival', 'Delivery Notes', 'Supplier Invoices'],
    ...overviewRows.map((o) => [o.order_number, o.supplier || '', o.order_date || '', o.ordered_cases, o.shipped_cases,
      o.delivered_cases, o.remaining_cases, o.business_status, o.pct, o.last_activity || '', o.next_eta ? String(o.next_eta).slice(0, 16).replace('T', ' ') : '',
      o.dns.map((d) => d.dn_number).join(', '), o.sis.map((s) => s.invoice_number).join(', ')]),
  ]);
  save(wb, 'Open_Orders.xlsx');
  return true;
}
