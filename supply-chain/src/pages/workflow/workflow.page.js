// Workflow — the document pipeline across orders and their PIs.
import { mount } from '../../utils/dom.js';
import { esc } from '../../utils/format.js';
import { orderBadge, piBadge, loading, emptyState, card, tableWrap } from '../../components/table/table.js';
import { listWorkflow, stageCounts, ORDER_STAGES } from '../../services/workflow/workflow.service.js';

export async function render(root, ctx) {
  mount(root, loading('Loading workflow…'));
  let orders;
  try { orders = await listWorkflow(); } catch (e) { mount(root, emptyState('⚠', e.message || String(e))); return; }
  const counts = stageCounts(orders);

  const flow = `<div class="erp-flow">${ORDER_STAGES.map((s, i) =>
    `<div class="erp-flow-node"><div class="erp-flow-count">${counts[s]}</div><div class="erp-flow-lbl">${s}</div></div>` +
    (i < ORDER_STAGES.length - 1 ? '<div class="erp-flow-arrow">→</div>' : '')).join('')}</div>`;

  const rows = orders.map((o) => {
    const step = ORDER_STAGES.indexOf(o.status);
    const dots = ORDER_STAGES.map((s, i) => `<span class="erp-step ${i <= step && step >= 0 ? 'done' : ''}" title="${s}"></span>`).join('');
    return `<tr>
      <td class="mono"><b>${esc(o.order_number)}</b></td><td>${esc(o.order_date || '')}</td>
      <td>${orderBadge(o.status)}</td><td><div class="erp-steps">${dots}</div></td>
      <td class="mono">${o.pi ? esc(o.pi.pi_number || '—') : '—'}</td>
      <td>${o.pi ? piBadge(o.pi.status) : '<span class="sc-badge none">—</span>'}</td>
      <td>${o.pi && o.pi.imported_at ? esc(String(o.pi.imported_at).slice(0, 10)) : '—'}</td></tr>`;
  }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:24px">No documents in the workflow yet</td></tr>';

  mount(root,
    card(`<div class="sc-card-h"><h3>🔀 Document workflow</h3></div>${flow}`) +
    card(`<div class="sc-card-h"><h3>Order → PI lifecycle</h3></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Order #</th><th>Date</th><th>Order Status</th><th>Progress</th><th>PI #</th><th>PI Status</th><th>Imported</th></tr></thead><tbody>${rows}</tbody></table>`)}`));
}
