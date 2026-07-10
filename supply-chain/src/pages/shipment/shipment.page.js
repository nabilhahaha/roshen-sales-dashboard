// Shipments — the logistics board for deliveries between invoice match and
// warehouse receipt: Ready for Delivery → In Transit (with expected delivery
// date & time) → confirm at the warehouse. Read-only view over the delivery
// notes' shipment stage; dispatch/ETA actions live on the DN detail.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { statusBadge } from '../../components/table/badges.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';

const STAGES = ['Ready for Delivery', 'In Transit'];

export async function render(root, ctx) {
  mount(root, loading('Loading shipments…'));
  let dns;
  try { dns = await listDeliveryNotes(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const now = Date.now();
  const shipments = dns.filter((d) => STAGES.includes(d.status));
  const overdue = (d) => d.status === 'In Transit' && d.expected_delivery_at && new Date(d.expected_delivery_at).getTime() < now;

  const rows = shipments.map((d) => `<tr class="sc-row-link" data-act="open" data-id="${d.id}">
      <td class="mono"><b>${esc(d.dn_number)}</b></td>
      <td class="mono">${esc((d.order && d.order.order_number) || d.po_reference || '—')}</td>
      <td>${esc(d.supplier || '')}</td>
      <td class="num">${qty(d.total_cartons)}</td>
      <td>${statusBadge(d.status)}</td>
      <td style="font-size:11.5px">${d.expected_delivery_at
        ? `${esc(String(d.expected_delivery_at).slice(0, 16).replace('T', ' '))}${overdue(d) ? ' <span class="sc-badge closed">Overdue</span>' : ''}`
        : '—'}</td>
      <td class="mono">${esc((d.invoice && d.invoice.invoice_number) || '—')}</td></tr>`).join('')
    || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:22px">No shipments on the way. A delivery becomes a shipment once its supplier invoice is matched.</td></tr>';

  mount(root, `
    <div class="sc-card-h"><h3>🛫 Shipments</h3>
      <span class="sc-badge none" style="margin-left:8px">${shipments.length}</span>
      <div class="sc-spacer"></div>
      <span style="font-size:12px;color:var(--text-secondary)">Ready for Delivery <b>${shipments.filter((d) => d.status === 'Ready for Delivery').length}</b> · In Transit <b>${shipments.filter((d) => d.status === 'In Transit').length}</b> · Overdue <b>${shipments.filter(overdue).length}</b></span></div>
    <div class="sc-card">
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Deliveries with a matched supplier invoice, on their way to the warehouse. Open one to update the ETA or confirm the warehouse receipt.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr>
        <th>Delivery Note</th><th>PI</th><th>Supplier</th><th class="num">Cartons</th><th>Status</th><th>Expected Delivery</th><th>Invoice</th></tr></thead>
        <tbody>${rows}</tbody></table>`)}
    </div>`);

  delegate(root, { open: ({ id }) => ctx.navigate('delivery-notes', { view: 'detail', dnId: +id }) });
}
