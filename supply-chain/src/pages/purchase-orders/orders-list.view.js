// Purchase Orders list — the ONE list renderer for purchase orders, shared by
// the Purchase Orders screen (active orders + New / Import actions) and the
// Purchase History screen (completed orders). Presentational only; the same
// services and actions as before — no duplicate list implementations.
import { mount, delegate } from '../../utils/dom.js';
import { esc, money, num } from '../../utils/format.js';
import { orderBadge, piBadge, loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { one } from '../../services/supabase/client.js';
import { listOrders, getOrder } from '../../services/purchase-orders/orders.service.js';
import { printOrder, exportOrderExcel } from '../../utils/documents.js';

const DONE_STATUSES = ['Closed', 'Financially Closed'];

// variant: 'active'  → orders still in the workflow, with New/Import actions
//          'history' → completed orders (read-only lifecycle view)
export async function renderOrdersList(root, ctx, variant = 'active') {
  const history = variant === 'history';
  let ORDERS = [];

  mount(root, `<div class="sc-card">
    <div class="sc-card-h"><h3>${history ? '📋 Purchase History' : '🛒 Purchase Orders'}</h3><div class="sc-spacer"></div>
      <input class="sc-input" style="max-width:240px" data-el="search" placeholder="🔎 Filter orders…">
      ${history ? '' : `<button class="sc-btn primary sm" style="margin-left:8px" data-act="importxl">📥 Import Purchase Order</button>
      <button class="sc-btn sm" data-act="new">➕ New Order</button>`}
      <button class="sc-btn ghost sm" data-act="refresh">↻</button>
    </div>
    <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">${history
      ? 'Completed purchase orders — fully received and closed. Active orders live under Purchase Orders.'
      : 'Purchase orders currently in the workflow. Import the supplier’s PI Excel to create one — completed orders move to Purchase History.'}</p>
    <div data-el="body">${loading()}</div>
  </div>`);

  const body = root.querySelector('[data-el="body"]');
  const search = root.querySelector('[data-el="search"]');

  async function load() {
    body.innerHTML = loading();
    try {
      const all = await listOrders();
      ORDERS = all.filter((o) => DONE_STATUSES.includes(o.status) === history);
    } catch (e) { body.innerHTML = emptyState('⚠', e.message || String(e)); return; }
    paint(ORDERS);
  }
  function paint(list) {
    if (!list.length) {
      body.innerHTML = emptyState('📭', history
        ? 'No completed purchase orders yet — orders arrive here once everything is received and the PI closes.'
        : 'No active purchase orders. Import the supplier’s PI Excel to start the workflow.');
      return;
    }
    const rows = list.map((o) => {
      const its = o.supply_order_items || [];
      const cases = its.reduce((a, b) => a + Number(b.ordered_cases || 0), 0);
      const value = its.reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0);
      const pi = one(o.proforma_invoices);
      return `<tr>
        <td class="mono"><b>${esc(o.order_number)}</b></td>
        <td>${esc(o.order_date || '')}</td>
        <td>${esc(o.supplier || '')}</td>
        <td>${esc(o.warehouse || '—')}</td>
        <td>${orderBadge(o.status)}</td>
        <td class="num">${its.length}</td>
        <td class="num">${num(cases)}</td>
        <td class="num">${money(value)}</td>
        <td>${pi ? piBadge(pi.status) + `<br><span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(pi.pi_number || '')}</span>` : '<span class="sc-badge none">—</span>'}</td>
        <td><div class="sc-actions-cell">
          <button class="sc-icon-btn" title="View" data-act="view" data-id="${o.id}">👁</button>
          ${o.status === 'Draft' ? `<button class="sc-icon-btn" title="Edit" data-act="edit" data-id="${o.id}">✏️</button>` : ''}
          ${o.status === 'Approved' && !pi ? `<button class="sc-icon-btn" title="Import PI" data-act="import" data-id="${o.id}">📥</button>` : ''}
          ${pi ? `<button class="sc-icon-btn" title="PI Validation" data-act="pi" data-id="${pi.id}">🧾</button>` : ''}
          <button class="sc-icon-btn" title="Duplicate" data-act="dup" data-id="${o.id}">⧉</button>
          <button class="sc-icon-btn" title="Print" data-act="print" data-id="${o.id}">🖨</button>
          <button class="sc-icon-btn" title="Excel" data-act="xls" data-id="${o.id}">⬇</button>
        </div></td></tr>`;
    }).join('');
    body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr>
      <th>Order #</th><th>Date</th><th>Supplier</th><th>Warehouse</th><th>Status</th>
      <th class="num">Items</th><th class="num">Cases</th><th class="num">Value (SAR)</th><th>PI</th><th>Actions</th>
    </tr></thead><tbody>${rows}</tbody></table>`);
  }

  const applyFilter = (q) => {
    q = (q || '').trim().toLowerCase();
    paint(!q ? ORDERS : ORDERS.filter((o) =>
      (o.order_number || '').toLowerCase().includes(q) || (o.supplier || '').toLowerCase().includes(q) ||
      (o.warehouse || '').toLowerCase().includes(q) || (o.status || '').toLowerCase().includes(q)));
  };
  search.addEventListener('input', () => applyFilter(search.value));
  ctx.pageSearch = applyFilter;

  delegate(root, {
    new: () => ctx.navigate('purchase-orders', { mode: 'new' }),
    importxl: () => ctx.navigate('import-order'),
    refresh: load,
    view: (d) => ctx.navigate('purchase-orders', { orderId: +d.id, mode: 'view' }),
    edit: (d) => ctx.navigate('purchase-orders', { orderId: +d.id, mode: 'edit' }),
    dup: (d) => ctx.navigate('purchase-orders', { duplicateFrom: +d.id }),
    import: (d) => ctx.navigate('pi-import', { orderId: +d.id }),
    pi: (d) => ctx.navigate('validation', { piId: +d.id }),
    print: async (d) => { try { const o = await getOrder(+d.id); if (!printOrder(o)) toast('Allow pop-ups to print', 'err'); } catch (e) { toast(e.message, 'err'); } },
    xls: async (d) => { try { exportOrderExcel(await getOrder(+d.id)); toast('Exported', 'ok'); } catch (e) { toast(e.message, 'err'); } },
  });

  if (ctx.params && ctx.params.q) { search.value = ctx.params.q; }
  await load();
  if (ctx.params && ctx.params.q) applyFilter(ctx.params.q);
}
