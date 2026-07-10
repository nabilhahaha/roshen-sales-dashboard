// Open Orders — THE operational tracking screen for every active Purchase
// Order: current business status (Approved → Shipped → Delivered, single
// source of truth in models/business-status.js), quantity flow, progress,
// last activity, expected arrival, and the related Delivery Notes / Supplier
// Invoices with one-click navigation. Fully delivered POs auto-close and move
// to Purchase History; a PO the supplier cannot complete is closed manually
// here (mandatory reason, audited, remaining quantity becomes Cancelled).
import { mount, delegate, qs } from '../../utils/dom.js';
import { esc, qty } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { openOrdersOverview } from '../../services/fulfillment/fulfillment.service.js';
import { closeOrderManually, listReplacementCandidates } from '../../services/purchase-orders/orders.service.js';
import { BIZ_VARIANT, CLOSE_REASONS } from '../../models/business-status.js';

const bizBadge = (s) => `<span class="sc-badge ${BIZ_VARIANT[s] || 'none'}">${esc(s)}</span>`;

export async function render(root, ctx) {
  mount(root, loading('Loading open orders…'));
  let orders;
  try { orders = await openOrdersOverview(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const OPEN_LINES = new Set(); // order ids with the line panel expanded

  paint();
  // delegated once — paint() only swaps innerHTML, so no listener stacking
  delegate(root, {
    open: ({ id }) => ctx.navigate('purchase-orders', { orderId: +id, mode: 'view' }),
    lines: ({ id }) => { const n = +id; OPEN_LINES.has(n) ? OPEN_LINES.delete(n) : OPEN_LINES.add(n); paint(); },
    opendn: ({ id }) => ctx.navigate('delivery-notes', { view: 'detail', dnId: +id }),
    opensi: ({ id }) => ctx.navigate('supplier-invoices', { view: 'detail', invoiceId: +id }),
    closepo: ({ id }) => closeDialog(orders.find((o) => o.id === +id)),
  });

  function paint() {
    const tot = orders.reduce((a, o) => ({
      ordered: a.ordered + o.ordered_cases, shipped: a.shipped + o.shipped_cases,
      delivered: a.delivered + o.delivered_cases, remaining: a.remaining + o.remaining_cases,
    }), { ordered: 0, shipped: 0, delivered: 0, remaining: 0 });

    const bar = (p) => `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:4px;background:var(--border-light);overflow:hidden;min-width:60px">
      <div style="width:${p}%;height:100%;background:${p >= 100 ? '#2FB344' : '#1971C2'}"></div></div><span style="font-size:11px;color:var(--text-muted);min-width:34px">${p}%</span></div>`;
    const chips = (list, act, label) => list.length
      ? list.map((d) => `<button class="sc-btn sm ghost mono" style="font-size:10.5px;padding:2px 7px" data-act="${act}" data-id="${d.id}" title="${esc(label)}">${esc(d.dn_number || d.invoice_number)}</button>`).join(' ')
      : '<span style="color:var(--text-muted);font-size:11px">—</span>';

    const rows = orders.map((o) => {
      const lines = OPEN_LINES.has(o.id) ? `<tr><td colspan="12" style="background:var(--bg-secondary);padding:8px 14px">
        ${tableWrap(`<table class="sc-table" style="min-width:0"><thead><tr>
          <th>Item</th><th class="num">Ordered</th><th class="num">Shipped</th><th class="num">Delivered</th><th class="num">Remaining</th><th>Line Status</th></tr></thead><tbody>
          ${o.lines.map((l) => `<tr>
            <td class="mono" style="font-size:11.5px"><b>${esc(l.roshen_id || l.item_code)}</b> <span style="color:var(--text-muted)">${esc((l.description || '').slice(0, 46))}</span></td>
            <td class="num">${qty(l.ordered)}</td><td class="num">${qty(l.shipped)}</td>
            <td class="num">${qty(l.delivered)}</td><td class="num"><b>${qty(l.remaining)}</b></td>
            <td>${bizBadge(l.business_status)}</td></tr>`).join('')}
        </tbody></table>`)}</td></tr>` : '';
      return `<tr class="sc-row-link" data-act="open" data-id="${o.id}">
        <td class="mono"><b>${esc(o.order_number)}</b>
          <button class="sc-btn sm ghost" style="padding:1px 6px;font-size:10px" data-act="lines" data-id="${o.id}" title="line items">${OPEN_LINES.has(o.id) ? '▲' : '▼'}</button></td>
        <td>${esc(o.supplier || '')}</td>
        <td style="font-size:11.5px">${esc(o.order_date || '')}</td>
        <td class="num">${qty(o.ordered_cases)}</td>
        <td class="num">${qty(o.shipped_cases)}</td>
        <td class="num">${qty(o.delivered_cases)}</td>
        <td class="num"><b>${qty(o.remaining_cases)}</b></td>
        <td>${bizBadge(o.business_status)}</td>
        <td style="min-width:100px">${bar(o.pct)}</td>
        <td style="font-size:11px;color:var(--text-secondary)">${esc(o.last_activity || '—')}${o.next_eta ? '<br>ETA ' + esc(String(o.next_eta).slice(0, 16).replace('T', ' ')) : ''}</td>
        <td style="max-width:160px">${chips(o.dns, 'opendn', 'Delivery Note')}<br>${chips(o.sis, 'opensi', 'Supplier Invoice')}</td>
        <td><button class="sc-btn sm ghost" data-act="closepo" data-id="${o.id}" title="Close this purchase order">✖ Close</button></td></tr>${lines}`;
    }).join('')
      || '<tr><td colspan="12" style="text-align:center;color:var(--text-muted);padding:22px">No open orders — everything is delivered or closed. Completed orders are in Purchase History. 🎉</td></tr>';

    mount(root, `
      <div class="sc-card-h"><h3>⏳ Open Orders</h3>
        <span class="sc-badge none" style="margin-left:8px">${orders.length}</span>
        <div class="sc-spacer"></div>
        <span style="font-size:12.5px;color:var(--text-secondary)">Ordered <b>${qty(tot.ordered)}</b> · Shipped <b>${qty(tot.shipped)}</b> · Delivered <b>${qty(tot.delivered)}</b> · Still expected <b>${qty(tot.remaining)}</b> cases</span></div>
      <div class="sc-card">
        <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Live business status per order: <b>Approved</b> → <b>Shipped</b> (delivery note confirmed) → <b>Delivered</b> (invoice matched &amp; goods posted). Fully delivered orders move to Purchase History automatically; use ✖ Close when the supplier cannot complete an order.</p>
        ${tableWrap(`<table class="sc-table"><thead><tr>
          <th>PO Number</th><th>Supplier</th><th>Order Date</th>
          <th class="num">Ordered</th><th class="num">Shipped</th><th class="num">Delivered</th><th class="num">Remaining</th>
          <th>Status</th><th>Progress</th><th>Last Activity / ETA</th><th>Related Docs</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table>`)}
      </div>
      <div data-el="closemodal"></div>`);
  }

  // ---- manual close dialog (mandatory reason, optional replacement link) ----
  async function closeDialog(o) {
    if (!o) return;
    const candidates = await listReplacementCandidates(o.id).catch(() => []);
    const host = qs('[data-el="closemodal"]', root);
    host.innerHTML = `<div class="sc-modal-overlay open"><div class="sc-modal" style="max-width:520px">
      <h4>Close Purchase Order ${esc(o.order_number)}?</h4>
      <p style="font-size:12.5px;color:var(--text-secondary)">This is a business action, not a delete: the order keeps its full history, the remaining <b>${qty(o.remaining_cases)}</b> cases become <b>Cancelled</b>, no new delivery notes or supplier invoices can be created against it, and it moves to Purchase History.</p>
      <div class="sc-field"><label>Close Reason *</label>
        <select class="sc-select" data-cl="reason"><option value="">— select a reason —</option>
          ${CLOSE_REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
      <div class="sc-field" style="margin-top:8px"><label>Comments <span style="color:var(--text-muted)">(required for “Other”)</span></label>
        <textarea class="sc-input" data-cl="comments" rows="2" placeholder="optional details"></textarea></div>
      <div class="sc-field" style="margin-top:8px"><label>Closed By *</label>
        <input class="sc-input" data-cl="by" placeholder="Your name"></div>
      <div class="sc-field" style="margin-top:8px"><label>Replaced by Purchase Order</label>
        <select class="sc-select" data-cl="repl"><option value="">— none —</option>
          ${candidates.map((r) => `<option value="${r.id}">${esc(r.order_number)}</option>`).join('')}</select></div>
      <div class="sc-modal-actions" style="margin-top:14px">
        <button class="sc-btn" style="background:#E03131;color:#fff" data-cl="confirm">✖ Close Purchase Order</button>
        <button class="sc-btn ghost" data-cl="cancel">Cancel</button>
      </div></div></div>`;
    const v = (k) => { const n = qs(`[data-cl="${k}"]`, host); return n ? n.value.trim() : ''; };
    qs('[data-cl="cancel"]', host).addEventListener('click', () => { host.innerHTML = ''; });
    qs('[data-cl="confirm"]', host).addEventListener('click', async () => {
      const reason = v('reason'), comments = v('comments'), by = v('by'), repl = v('repl');
      if (!reason) return toast('Select a close reason', 'err');
      if (reason === 'Other' && !comments) return toast('Add a comment explaining the reason', 'err');
      if (!by) return toast('Enter who is closing the order', 'err');
      try {
        await closeOrderManually(o.id, { reason, comments, closedBy: by, replacedByOrderId: repl ? +repl : null });
        toast(`Purchase order ${o.order_number} closed — moved to Purchase History`, 'ok');
        host.innerHTML = '';
        orders = await openOrdersOverview();
        paint();
      } catch (e) { toast(e.message || String(e), 'err'); }
    });
  }
}
