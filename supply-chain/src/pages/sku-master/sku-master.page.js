// SKU Master — browse/search the imported Roshen catalogue.
import { mount } from '../../utils/dom.js';
import { esc, money } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { listSkus } from '../../services/sku/sku.service.js';

let CACHE = [];

export async function render(root, ctx) {
  mount(root, loading('Loading SKU Master…'));
  try {
    CACHE = await listSkus({ activeOnly: false });
  } catch (e) {
    mount(root, emptyState('⚠', e.message || String(e)));
    return;
  }
  mount(root, `
    <div class="sc-card">
      <div class="sc-card-h">
        <h3>🧾 SKU Master</h3>
        <span class="sc-badge none" style="margin-left:8px">${CACHE.length} items</span>
        <div class="sc-spacer"></div>
        <input class="sc-input" style="max-width:260px" data-el="search" placeholder="🔎 Search code or description…">
      </div>
      <div data-el="body"></div>
    </div>`);
  const body = root.querySelector('[data-el="body"]');
  const search = root.querySelector('[data-el="search"]');
  const paint = (list) => {
    const rows = list.map((s) => `
      <tr>
        <td class="mono">${esc(s.roshen_id || '—')}</td>
        <td class="mono"><b>${esc(s.item_code)}</b></td>
        <td>${esc(s.item_description || '')}</td>
        <td class="num">${money(s.price_case)}</td>
        <td>${s.status === 'active' ? '<span class="sc-badge confirmed">active</span>' : `<span class="sc-badge draft">${esc(s.status)}</span>`}</td>
      </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:20px">No matching SKU</td></tr>';
    body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr><th>Roshen ID</th><th>Item Code</th><th>Description</th><th class="num">Price / Case (SAR)</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`);
  };
  const applyFilter = (q) => {
    q = (q || '').trim().toLowerCase();
    paint(!q ? CACHE : CACHE.filter((s) =>
      (s.item_code || '').toLowerCase().includes(q) ||
      (s.item_description || '').toLowerCase().includes(q) ||
      String(s.roshen_id || '').includes(q)));
  };
  search.addEventListener('input', () => applyFilter(search.value));
  if (ctx.params && ctx.params.q) { search.value = ctx.params.q; applyFilter(ctx.params.q); } else paint(CACHE);
  // expose for global search
  ctx.pageSearch = applyFilter;
}
