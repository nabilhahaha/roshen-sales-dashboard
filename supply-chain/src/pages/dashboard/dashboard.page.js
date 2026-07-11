// Executive Procurement Dashboard — the management view of the purchasing
// workflow: what is open, what is waiting on whom, and what needs attention
// right now. Read-only aggregation over the existing services; every tile and
// alert clicks through to the module where the work happens.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty, num } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { statusBadge } from '../../components/table/badges.js';
import { orderBadge } from '../../components/table/table.js';
import { listOpenOrders } from '../../services/fulfillment/fulfillment.service.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';
import { listInvoices } from '../../services/supplier-invoice/supplier-invoice.service.js';
import { listExceptions } from '../../services/goods-receiving/goods-receiving.service.js';

const ACTIVE_DN = ['Imported', 'Draft'];
const IN_TRANSIT = ['Ready for Delivery', 'In Transit', 'Receiving Review'];
const PENDING_SI = ['Pending Matching', 'Imported', 'Disputed'];

export async function render(root, ctx) {
  mount(root, loading('Loading procurement overview…'));
  let open, dns, invoices, exceptions;
  try {
    [open, dns, invoices, exceptions] = await Promise.all([
      listOpenOrders(),
      listDeliveryNotes(),
      listInvoices(),
      listExceptions().catch(() => []),
    ]);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const now = Date.now();
  const remaining = open.reduce((a, o) => a + Number(o.remaining_cases || 0), 0);
  // waiting queues, straight from the workflow stages
  const pendingDn = dns.filter((d) => ACTIVE_DN.includes(d.status));            // delivered on paper, invoice not matched yet
  const pendingRecv = dns.filter((d) => IN_TRANSIT.includes(d.status));         // matched / on the way / being received
  const pendingSi = invoices.filter((i) => PENDING_SI.includes(i.status) && (i.doc_type == null || i.doc_type === 'invoice'));

  // critical alerts — things a manager should chase today
  const alerts = [];
  dns.filter((d) => d.status === 'In Transit' && d.expected_delivery_at && new Date(d.expected_delivery_at).getTime() < now)
    .forEach((d) => alerts.push({ icon: '⏰', label: `Shipment overdue — ${esc(d.dn_number)} was expected ${esc(String(d.expected_delivery_at).slice(0, 16).replace('T', ' '))}`, act: 'opendn', id: d.id, badge: 'In Transit' }));
  invoices.filter((i) => i.status === 'Disputed').forEach((i) =>
    alerts.push({ icon: '⚖', label: `Invoice ${esc(i.invoice_number)} is disputed — reconcile with the delivery`, act: 'opensi', id: i.id, badge: 'Disputed' }));
  invoices.filter((i) => i.status === 'Pending Matching').forEach((i) =>
    alerts.push({ icon: '🔗', label: `Invoice ${esc(i.invoice_number)} waits for its PI / Delivery Note (${esc(i.dn_reference || '—')})`, act: 'opensi', id: i.id, badge: 'Pending Matching' }));
  dns.filter((d) => ACTIVE_DN.includes(d.status) && !d.invoice).forEach((d) =>
    alerts.push({ icon: '🧾', label: `Delivery ${esc(d.dn_number)} has no supplier invoice yet — upload and match it`, act: 'opendn', id: d.id, badge: d.status }));

  const tile = (act, icon, label, value, sub, warn) => `
    <div class="erp-kpi ${warn && value > 0 ? 'warn' : ''} sc-row-link" data-act="${act}" style="cursor:pointer">
      <div class="k-lbl">${icon} ${label}</div><div class="k-val">${num(value)}</div><div class="k-sub">${sub}</div></div>`;

  const alertRows = alerts.slice(0, 12).map((a) => `<tr class="sc-row-link" data-act="${a.act}" data-id="${a.id || ''}">
      <td style="width:30px">${a.icon}</td><td style="font-size:12.5px">${a.label}</td>
      <td>${statusBadge(a.badge)}</td><td style="text-align:right;color:var(--text-muted)">→</td></tr>`).join('');

  mount(root, `
    <div class="erp-kpi-row">
      ${tile('openorders', '⏳', 'Open Orders', open.length, `${qty(remaining)} cases still expected`)}
      ${tile('dns', '🚚', 'Pending Delivery Notes', pendingDn.length, 'awaiting invoice match')}
      ${tile('receiving', '📦', 'Pending Receiving', pendingRecv.length, 'ready / in transit / at the gate')}
      ${tile('invoices', '🧾', 'Pending Supplier Invoices', pendingSi.length, 'unmatched or disputed', true)}
      ${tile('invoices', '⚠️', 'Exceptions', exceptions.length, 'shelf-life decisions on record', true)}
      ${tile('alerts', '🚨', 'Critical Alerts', alerts.length, 'need attention today', true)}
    </div>
    <div class="sc-card" id="alerts">
      <div class="sc-card-h"><h3>🚨 Critical Alerts</h3><div class="sc-spacer"></div>
        <span class="sc-badge ${alerts.length ? 'closed' : 'confirmed'}">${alerts.length}</span></div>
      ${alerts.length
        ? tableWrap(`<table class="sc-table"><tbody>${alertRows}</tbody></table>`) +
          (alerts.length > 12 ? `<div style="padding:8px 2px 0;font-size:12px;color:var(--text-muted)">…and ${alerts.length - 12} more — see the module screens.</div>` : '')
        : '<p style="font-size:12.5px;color:var(--text-secondary);margin:0">Nothing needs attention — the workflow is on track. 🎉</p>'}
    </div>
    <div class="sc-card">
      <div class="sc-card-h"><h3>⏳ Open Orders</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="openorders">Open Orders →</button></div>
      ${open.length ? tableWrap(`<table class="sc-table"><thead><tr>
          <th>PI Number</th><th>Supplier</th><th>Expected Delivery</th><th class="num">Remaining Qty</th><th>Status</th><th></th></tr></thead><tbody>
          ${open.slice(0, 8).map((o) => `<tr class="sc-row-link" data-act="openpo" data-id="${o.id}">
            <td class="mono"><b>${esc(o.order_number)}</b></td><td>${esc(o.supplier || '')}</td>
            <td style="font-size:11.5px">${o.next_eta ? esc(String(o.next_eta).slice(0, 16).replace('T', ' ')) : '—'}</td>
            <td class="num"><b>${qty(o.remaining_cases)}</b></td><td>${orderBadge(o)}</td>
            <td><button class="sc-btn sm ghost" data-act="bizfile" data-id="${o.id}" title="Open the Business File">📁 File</button></td></tr>`).join('')}
        </tbody></table>`)
        : '<p style="font-size:12.5px;color:var(--text-secondary);margin:0">No open orders — everything is fully received and closed.</p>'}
    </div>`);

  delegate(root, {
    openorders: () => ctx.navigate('open-orders'),
    dns: () => ctx.navigate('delivery-notes'),
    receiving: () => ctx.navigate('goods-receiving'),
    invoices: () => ctx.navigate('supplier-invoices'),
    alerts: () => { const el = root.querySelector('#alerts'); if (el) el.scrollIntoView({ behavior: 'smooth' }); },
    openpo: (d) => ctx.navigate('purchase-orders', { orderId: +d.id, mode: 'view' }),
    bizfile: (d) => ctx.navigate('business-files', { orderId: +d.id }),
    opendn: (d) => ctx.navigate('delivery-notes', { view: 'detail', dnId: +d.id }),
    opensi: (d) => ctx.navigate('supplier-invoices', { view: 'detail', invoiceId: +d.id }),
  });
}
