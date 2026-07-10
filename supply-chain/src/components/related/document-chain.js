// Document Chain — the ONE Related-Documents implementation, shared by every
// document detail page (Purchase Order, Delivery Note, Warehouse Receipt,
// Supplier Invoice). For a purchase order it shows the complete, permanent
// chain with one-click navigation:
//
//   Purchase Order (PI) → Delivery Note(s) → Warehouse Receipt(s) (GRN)
//   → Supplier Invoice(s) [→ replacement / replaced purchase orders]
//
// The chain never disappears: closed, archived and fully delivered orders keep
// every link for audit. Statuses render in the business vocabulary (single
// source of truth — models/business-status.js).
import { esc } from '../../utils/format.js';
import { getClient, one } from '../../services/supabase/client.js';
import { statusBadge } from '../table/badges.js';
import { orderBadge } from '../table/table.js';
import { siBusinessStatus } from '../../models/business-status.js';

// fetch the whole chain for one purchase order
export async function documentChain(orderId) {
  const c = getClient();
  const [{ data: order }, { data: dns }, { data: grs }, { data: sis }] = await Promise.all([
    c.from('supply_orders').select('id,order_number,status,close_reason,closed_by,replaced_by_order_id').eq('id', orderId).single(),
    c.from('delivery_notes').select('id,dn_number,dn_date,status').eq('order_id', orderId).order('dn_number'),
    c.from('goods_receipts').select('id,grn_number,receipt_date,status,delivery_note_id').eq('order_id', orderId).order('id'),
    c.from('supplier_invoices').select('id,invoice_number,invoice_date,status,delivery_note_id').eq('order_id', orderId).order('id'),
  ]);
  let replacedBy = null, replaces = [];
  if (order && order.replaced_by_order_id) {
    const { data: r } = await c.from('supply_orders').select('id,order_number,status,close_reason').eq('id', order.replaced_by_order_id).single();
    replacedBy = r || null;
  }
  if (order) {
    const { data: r } = await c.from('supply_orders').select('id,order_number,status,close_reason').eq('replaced_by_order_id', order.id);
    replaces = r || [];
  }
  return { order, dns: dns || [], grs: grs || [], sis: sis || [], replacedBy, replaces };
}

// renderDocumentChain(el, navigate, { orderId, current: { type, id } })
// current marks the document whose page we're on (rendered without a link).
export async function renderDocumentChain(el, navigate, { orderId, current = {} } = {}) {
  if (!el || !orderId) return;
  let chain;
  try { chain = await documentChain(orderId); } catch (e) { return; }
  if (!chain.order) return;
  const dnById = {}; chain.dns.forEach((d) => { dnById[d.id] = d; });

  const isCurrent = (type, id) => current.type === type && Number(current.id) === Number(id);
  const row = (type, id, icon, label, number, date, badge) => `
    <tr${isCurrent(type, id) ? ' style="background:rgba(25,113,194,.07)"' : ' class="sc-row-link" data-chain="' + type + ':' + id + '"'}>
      <td style="white-space:nowrap">${icon} ${esc(label)}</td>
      <td class="mono"><b>${esc(number)}</b>${isCurrent(type, id) ? ' <span style="font-size:10px;color:var(--text-muted)">(this document)</span>' : ''}</td>
      <td style="font-size:11.5px">${esc(date || '')}</td>
      <td>${badge}</td>
      <td style="text-align:right;color:var(--text-muted)">${isCurrent(type, id) ? '' : '→'}</td></tr>`;

  const rows = [
    row('purchase_order', chain.order.id, '📄', 'Purchase Order (PI)', chain.order.order_number, '', orderBadge(chain.order)),
    ...chain.dns.map((d) => row('delivery_note', d.id, '🚚', 'Delivery Note', d.dn_number, d.dn_date, statusBadge(d.status))),
    ...chain.grs.map((g) => row('goods_receipt', g.id, '📦', 'Warehouse Receipt (GRN)',
      (g.grn_number || '#' + g.id) + (dnById[g.delivery_note_id] ? ' · ' + dnById[g.delivery_note_id].dn_number : ''),
      g.receipt_date, statusBadge(g.status))),
    ...chain.sis.map((s) => row('supplier_invoice', s.id, '🧾', 'Supplier Invoice', s.invoice_number, s.invoice_date,
      statusBadge(siBusinessStatus(s.status, (dnById[s.delivery_note_id] || {}).status)))),
    ...(chain.replacedBy ? [row('purchase_order', chain.replacedBy.id, '↪', 'Replaced By', chain.replacedBy.order_number, '', orderBadge(chain.replacedBy))] : []),
    ...chain.replaces.map((r) => row('purchase_order', r.id, '↩', 'Replaces (closed)', r.order_number, '', orderBadge(r))),
  ].join('');

  el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🔗 Related Documents — Document Chain</h3><div class="sc-spacer"></div>
      <span style="font-size:11.5px;color:var(--text-muted)">${chain.dns.length} delivery note(s) · ${chain.grs.length} receipt(s) · ${chain.sis.length} invoice(s)</span></div>
    <div class="sc-table-wrap"><table class="sc-table"><tbody>${rows}</tbody></table></div>
    <p style="font-size:11px;color:var(--text-muted);margin:8px 0 0">The chain is permanent — it stays complete after delivery, closure or archiving.</p></div>`;

  el.querySelectorAll('[data-chain]').forEach((tr) => tr.addEventListener('click', () => {
    const [type, id] = tr.dataset.chain.split(':');
    if (type === 'purchase_order') navigate('purchase-orders', { orderId: +id, mode: 'view' });
    else if (type === 'delivery_note') navigate('delivery-notes', { view: 'detail', dnId: +id });
    else if (type === 'goods_receipt') navigate('goods-receiving', { view: 'detail', grId: +id });
    else if (type === 'supplier_invoice') navigate('supplier-invoices', { view: 'detail', invoiceId: +id });
  }));
}
