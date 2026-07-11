// Business Timeline — the complete document journey of one purchase order,
// assembled READ-ONLY from data the workflow already records (order fields,
// po/dn/si audit logs, receipt timestamps). No business logic — presentation
// of the existing audit trail as one chronological story:
//   PO Created → Approved → Delivery Note Created → Shipment Confirmed →
//   Goods Receipt Completed → Supplier Invoice Posted → Delivered → Closed
import { getClient } from '../supabase/client.js';

const ev = (at, icon, label, user, doc) => ({ at, icon, label, user: user || null, doc: doc || null });

export async function buildBusinessTimeline(orderId) {
  const c = getClient();
  const [{ data: order }, { data: dns }, { data: grs }, { data: sis }, { data: poAudit }] = await Promise.all([
    c.from('supply_orders').select('*').eq('id', orderId).single(),
    c.from('delivery_notes').select('id,dn_number,status,created_at,created_by,received_by').eq('order_id', orderId),
    c.from('goods_receipts').select('id,grn_number,status,created_at,released_at,created_by').eq('order_id', orderId),
    c.from('supplier_invoices').select('id,invoice_number,status,created_at,created_by,delivery_note_id').eq('order_id', orderId),
    c.from('po_audit_log').select('*').eq('order_id', orderId),
  ]);
  const { data: amds } = await c.from('po_amendments')
    .select('amendment_no,status,reason,created_by,created_at,applied_by,applied_at')
    .eq('order_id', orderId);
  if (!order) return [];
  const dnById = {}; (dns || []).forEach((d) => { dnById[d.id] = d; });
  const [{ data: dnAudit }, { data: siAudit }] = await Promise.all([
    (dns || []).length ? c.from('dn_audit_log').select('dn_id,action,detail,actor,created_at').in('dn_id', (dns || []).map((d) => d.id))
      : Promise.resolve({ data: [] }),
    (sis || []).length ? c.from('supplier_invoice_audit_log').select('invoice_id,action,actor,created_at').in('invoice_id', (sis || []).map((s) => s.id))
      : Promise.resolve({ data: [] }),
  ]);

  const events = [];
  events.push(ev(order.created_at, '➕', 'Purchase Order created', order.created_by, order.order_number));
  if (order.approved_at) events.push(ev(order.approved_at, '✅', 'Purchase Order approved', null, order.order_number));

  // amendments take their real place in the story, ordered by time
  (amds || []).forEach((a) => {
    const no = 'AMD-' + String(a.amendment_no).padStart(2, '0');
    events.push(ev(a.created_at, '📝', `Amendment ${no} created — ${a.reason}`, a.created_by, no));
    if (a.applied_at) events.push(ev(a.applied_at, '⚡', `Amendment ${no} applied — order updated`, a.applied_by, no));
  });

  (dns || []).forEach((d) => {
    events.push(ev(d.created_at, '🚚', `Delivery Note ${d.dn_number} created`, d.created_by, d.dn_number));
  });
  (dnAudit || []).forEach((a) => {
    const d = dnById[a.dn_id] || {};
    if (a.action === 'status_change' && a.detail && a.detail.to === 'In Transit')
      events.push(ev(a.created_at, '🛫', `Shipment confirmed — ${d.dn_number} SHIPPED`, a.actor, d.dn_number));
    if (a.action === 'cancelled') events.push(ev(a.created_at, '✖', `Delivery Note ${d.dn_number} cancelled`, a.actor, d.dn_number));
    if (a.action === 'reversed') events.push(ev(a.created_at, '↩', `Delivery Note ${d.dn_number} reversed`, a.actor, d.dn_number));
  });

  (sis || []).forEach((s) => {
    events.push(ev(s.created_at, '🧾', `Supplier Invoice ${s.invoice_number} uploaded`, s.created_by, s.invoice_number));
  });
  (siAudit || []).forEach((a) => {
    const s = (sis || []).find((x) => x.id === a.invoice_id) || {};
    if (a.action === 'matched') events.push(ev(a.created_at, '🔗', `Supplier Invoice ${s.invoice_number} matched`, a.actor, s.invoice_number));
    if (a.action === 'disputed') events.push(ev(a.created_at, '⚠', `Supplier Invoice ${s.invoice_number} disputed`, a.actor, s.invoice_number));
  });

  (grs || []).forEach((g) => {
    events.push(ev(g.created_at, '📦', `Warehouse receipt ${g.grn_number} created`, g.created_by, g.grn_number));
    if (g.released_at && ['Released', 'Partially Released'].includes(g.status)) {
      const d = dnById[g.delivery_note_id] || {};
      events.push(ev(g.released_at, '🏬', `Goods Receipt ${g.grn_number} completed — inventory posted · DELIVERED`, d.received_by || null, g.grn_number));
    }
  });

  (poAudit || []).forEach((a) => {
    if (a.action === 'closed') {
      const det = a.details || {};
      events.push(ev(a.created_at, '✖', `Purchase Order closed — ${det.reason || ''}`, a.actor, order.order_number));
    }
  });
  if (order.status === 'Closed' && !order.close_reason) {
    events.push(ev(order.updated_at, '🏁', 'Purchase Order fully DELIVERED — auto-closed', null, order.order_number));
  }

  return events.filter((e) => e.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}
