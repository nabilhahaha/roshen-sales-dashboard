// Dashboard — Supply Chain KPIs only.
import { mount } from '../../utils/dom.js';
import { money, num } from '../../utils/format.js';
import { orderBadge, piBadge, loading, emptyState, card, tableWrap } from '../../components/table/table.js';
import { countSkus } from '../../services/sku/sku.service.js';
import { listOrders } from '../../services/purchase-orders/orders.service.js';
import { listPis } from '../../services/pi/pi.service.js';
import { ORDER_STAGES as STAGE_NAMES, ORDER_STAGE_COLOR } from '../../models/order-status.js';

const ORDER_STAGES = STAGE_NAMES.map((s) => [s, ORDER_STAGE_COLOR[s] || '#8FA3BD']);

export async function render(root, ctx) {
  mount(root, loading('Loading supply-chain metrics…'));
  try {
    const [skuCount, orders, pis] = await Promise.all([countSkus(), listOrders(), listPis()]);

    const byStatus = {}; ORDER_STAGES.forEach(([s]) => (byStatus[s] = 0));
    let poValue = 0;
    orders.forEach((o) => {
      if (byStatus[o.status] != null) byStatus[o.status]++;
      (o.supply_order_items || []).forEach((i) => (poValue += Number(i.ordered_cases || 0) * Number(i.price_case || 0)));
    });
    const piByStatus = { Imported: 0, 'Validation Required': 0, Approved: 0, Rejected: 0 };
    let piNet = 0;
    pis.forEach((p) => { if (piByStatus[p.status] != null) piByStatus[p.status]++; piNet += Number(p.total_taxable || 0); });
    const open = byStatus.Draft + byStatus.Approved;
    const pending = piByStatus['Validation Required'];
    if (ctx.setNotif) ctx.setNotif(pending);

    const kpi = (l, v, s, cls = '') => `<div class="erp-kpi ${cls}"><div class="k-lbl">${l}</div><div class="k-val">${v}</div><div class="k-sub">${s}</div></div>`;
    const maxP = Math.max(1, ...ORDER_STAGES.map(([s]) => byStatus[s]));

    const recent = orders.slice(0, 6).map((o) => {
      const cases = (o.supply_order_items || []).reduce((a, b) => a + Number(b.ordered_cases || 0), 0);
      const val = (o.supply_order_items || []).reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0);
      return `<tr><td class="mono"><b>${o.order_number}</b></td><td>${o.order_date || ''}</td><td>${orderBadge(o.status)}</td><td class="num">${num(cases)}</td><td class="num">${money(val)}</td></tr>`;
    }).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px">No purchase orders yet</td></tr>';

    mount(root, `
      <div class="erp-kpi-row">
        ${kpi('Active SKUs', num(skuCount), 'in SKU Master')}
        ${kpi('Purchase Orders', num(orders.length), `${open} open · ${byStatus.Closed} closed`)}
        ${kpi('PO Value (net)', money(poValue), 'SAR across all orders', 'accent')}
        ${kpi('Proforma Invoices', num(pis.length), `${pending} need validation`, pending ? 'warn' : '')}
      </div>
      <div class="erp-grid-2">
        ${card(`<div class="sc-card-h"><h3>📦 Purchase-order pipeline</h3></div>
          <div class="erp-pipe">${ORDER_STAGES.map(([s, c]) => `
            <div class="erp-pipe-row"><div class="erp-pipe-lbl">${s}</div>
            <div class="erp-pipe-bar"><div class="erp-pipe-fill" style="width:${Math.round((byStatus[s] / maxP) * 100)}%;background:${c}"></div></div>
            <div class="erp-pipe-val">${byStatus[s]}</div></div>`).join('')}</div>`)}
        ${card(`<div class="sc-card-h"><h3>🧾 PI status</h3></div>
          <div class="erp-pi-stats">${['Imported', 'Validation Required', 'Approved', 'Rejected'].map((s) =>
            `<div class="erp-pi-stat">${piBadge(s)}<b>${piByStatus[s]}</b></div>`).join('')}</div>
          <div class="erp-pi-net">Imported PI value (net): <b>${money(piNet)} SAR</b></div>`)}
      </div>
      ${card(`<div class="sc-card-h"><h3>🕒 Recent purchase orders</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm" data-goto="order-history">View all →</button></div>
        ${tableWrap(`<table class="sc-table"><thead><tr><th>Order #</th><th>Date</th><th>Status</th><th class="num">Cases</th><th class="num">Value (SAR)</th></tr></thead><tbody>${recent}</tbody></table>`)}`)}
    `);
    root.querySelector('[data-goto="order-history"]')?.addEventListener('click', () => ctx.navigate('order-history'));
  } catch (e) {
    mount(root, emptyState('⚠', 'Could not load metrics: ' + (e.message || e)));
  }
}
