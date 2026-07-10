// Open Orders — every purchase order that is not yet completely received and
// closed, with live totals: what has arrived, what is still expected from the
// supplier, and when. Opening an order lands on the PI dashboard, which shows
// only the remaining items by default.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty } from '../../utils/format.js';
import { loading, emptyState, tableWrap, orderBadge } from '../../components/table/table.js';
import { listOpenOrders } from '../../services/fulfillment/fulfillment.service.js';

export async function render(root, ctx) {
  mount(root, loading('Loading open orders…'));
  let orders;
  try { orders = await listOpenOrders(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const tot = orders.reduce((a, o) => ({ ordered: a.ordered + o.ordered_cases, received: a.received + o.received_cases, remaining: a.remaining + o.remaining_cases }), { ordered: 0, received: 0, remaining: 0 });
  const bar = (p) => `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:4px;background:var(--border-light);overflow:hidden">
    <div style="width:${p}%;height:100%;background:${p >= 100 ? '#2FB344' : '#1971C2'}"></div></div><span style="font-size:11px;color:var(--text-muted);min-width:34px">${p}%</span></div>`;

  const rows = orders.map((o) => `<tr class="sc-row-link" data-act="open" data-id="${o.id}">
      <td class="mono"><b>${esc(o.order_number)}</b></td>
      <td>${esc(o.supplier || '')}</td>
      <td>${esc(o.order_date || '')}</td>
      <td style="font-size:11.5px">${o.next_eta ? esc(String(o.next_eta).slice(0, 16).replace('T', ' ')) : esc(o.expected_arrival || '—')}</td>
      <td style="min-width:110px">${bar(o.pct)}</td>
      <td class="num">${qty(o.ordered_cases)}</td>
      <td class="num">${qty(o.received_cases)}</td>
      <td class="num"><b>${qty(o.remaining_cases)}</b></td>
      <td>${orderBadge(o.status)}</td></tr>`).join('')
    || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:22px">No open orders — everything is fully received and closed. 🎉</td></tr>';

  mount(root, `
    <div class="sc-card-h"><h3>⏳ Open Orders</h3>
      <span class="sc-badge none" style="margin-left:8px">${orders.length}</span>
      <div class="sc-spacer"></div>
      <span style="font-size:12.5px;color:var(--text-secondary)">Still expected from supplier: <b>${qty(tot.remaining)}</b> cases · Received <b>${qty(tot.received)}</b> of <b>${qty(tot.ordered)}</b></span></div>
    <div class="sc-card">
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Purchase orders not yet completely received. Open one to see its remaining items — completed items are hidden by default. Orders close automatically when every ordered quantity is received.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr>
        <th>PI Number</th><th>Supplier</th><th>Order Date</th><th>Expected Arrival</th><th>Progress</th>
        <th class="num">Ordered</th><th class="num">Received</th><th class="num">Remaining</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table>`)}
    </div>`);

  delegate(root, { open: ({ id }) => ctx.navigate('purchase-orders', { orderId: id, mode: 'view' }) });
}
