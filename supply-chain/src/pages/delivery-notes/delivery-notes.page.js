// Delivery Notes — list, import (choose PO → upload → map → review → create),
// and the DN detail screen (invoice match + goods receipt). Pages talk only to
// services. Sub-view is chosen by ctx.params.view.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { statusBadge } from '../../components/table/badges.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';
import { startDnImport } from './dn-import.flow.js';
import { renderDnDetail } from './dn-detail.view.js';
import { startInvoiceUpload } from './invoice-upload.flow.js';

export async function render(root, ctx) {
  const view = (ctx.params && ctx.params.view) || 'list';
  if (view === 'import') return startDnImport(root, ctx);
  if (view === 'invoice' && ctx.params.dnId) return startInvoiceUpload(root, ctx, ctx.params.dnId);
  if (view === 'detail' && ctx.params.dnId) return renderDnDetail(root, ctx, ctx.params.dnId);
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  mount(root, loading('Loading delivery notes…'));
  let dns;
  try { dns = await listDeliveryNotes(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const rows = dns.map((d) => {
    const inv = d.invoice
      ? statusBadge(d.invoice.status === 'Matched' ? 'Matched' : d.invoice.status)
      : '<span class="sc-badge none">none</span>';
    const gr = d.goods_receipt ? statusBadge(d.goods_receipt.status) : '<span class="sc-badge none">—</span>';
    return `<tr class="sc-row-link" data-act="open" data-id="${d.id}">
      <td class="mono"><b>${esc(d.dn_number)}</b></td>
      <td>${esc(d.dn_date || '')}</td>
      <td class="mono">${esc((d.order && d.order.order_number) || '')}</td>
      <td>${esc(d.supplier || '')}</td>
      <td class="num">${qty(d.total_cartons)}</td>
      <td>${statusBadge(d.status)}</td>
      <td>${inv}</td>
      <td>${gr}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:22px">No deliveries yet — add one when the supplier sends a delivery note.</td></tr>';

  mount(root, `
    <div class="sc-card-h"><h3>🚚 Delivery Notes</h3>
      <span class="sc-badge none" style="margin-left:8px">${dns.length}</span>
      <div class="sc-spacer"></div>
      <button class="sc-btn primary" data-act="import">➕ Add Delivery Note</button></div>
    <div class="sc-card">
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">A PI can have several deliveries. Each delivery needs a matched supplier invoice before it can be received into the warehouse.</p>
      ${tableWrap(`<table class="sc-table sc-cardify"><thead><tr>
        <th>Delivery Note</th><th>Date</th><th>PI</th><th>Supplier</th><th class="num">Cartons</th>
        <th>Status</th><th>Invoice</th><th>Warehouse Receipt</th></tr></thead>
        <tbody>${rows}</tbody></table>`)}
    </div>`);

  delegate(root, {
    import: () => ctx.navigate('delivery-notes', { view: 'import' }),
    open: ({ id }) => ctx.navigate('delivery-notes', { view: 'detail', dnId: id }),
  });
}
