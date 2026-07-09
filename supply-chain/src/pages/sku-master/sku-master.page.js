// SKU Master — browse/search the imported Roshen catalogue and maintain the
// shelf-life master data (value + unit + minimum receiving %) used by the
// Delivery-Note shelf-life calculations.
import { mount, delegate } from '../../utils/dom.js';
import { esc, money } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { listSkus, updateShelfLife } from '../../services/sku/sku.service.js';

let CACHE = [];

const shelfText = (s) =>
  s.shelf_life_value != null && s.shelf_life_unit
    ? `${esc(String(s.shelf_life_value))} ${esc(s.shelf_life_unit)}`
    : '<span style="color:var(--text-muted)">—</span>';
const minText = (s) =>
  s.min_remaining_shelf_life_pct != null
    ? `<span class="sc-badge pi">${esc(String(s.min_remaining_shelf_life_pct))}%</span>`
    : '<span style="color:var(--text-muted)">—</span>';

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
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Shelf Life and Minimum Receiving % are maintained manually here. Expiry dates come from each Delivery Note batch; all shelf-life percentages are calculated dynamically from the dates.</p>
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
        <td>${shelfText(s)}</td>
        <td class="num">${minText(s)}</td>
        <td>${s.status === 'active' ? '<span class="sc-badge confirmed">active</span>' : `<span class="sc-badge draft">${esc(s.status)}</span>`}</td>
        <td><button class="sc-btn sm ghost" data-act="edit" data-id="${s.id}">Shelf life</button></td>
      </tr>`).join('') || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:20px">No matching SKU</td></tr>';
    body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr>
      <th>Roshen ID</th><th>Item Code</th><th>Description</th><th class="num">Price / Case</th>
      <th>Shelf Life</th><th class="num">Min Rcv %</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`);
  };
  const applyFilter = (q) => {
    q = (q || '').trim().toLowerCase();
    paint(!q ? CACHE : CACHE.filter((s) =>
      (s.item_code || '').toLowerCase().includes(q) ||
      (s.item_description || '').toLowerCase().includes(q) ||
      String(s.roshen_id || '').includes(q)));
  };

  delegate(root, {
    edit: ({ id }) => openEditor(CACHE.find((s) => String(s.id) === String(id)), () => applyFilter(search.value)),
  });
  search.addEventListener('input', () => applyFilter(search.value));
  if (ctx.params && ctx.params.q) { search.value = ctx.params.q; applyFilter(ctx.params.q); } else paint(CACHE);
  ctx.pageSearch = applyFilter;
}

function openEditor(sku, onSaved) {
  if (!sku) return;
  const unitOpt = ['Days', 'Months', 'Years'].map((x) =>
    `<option value="${x}" ${sku.shelf_life_unit === x ? 'selected' : ''}>${x}</option>`).join('');
  modal(`Shelf life · ${sku.item_code}`, `
    <div style="font-size:12px;color:var(--text-secondary);margin-bottom:10px">${esc(sku.item_description || '')}</div>
    <div class="sc-form-grid">
      <div class="sc-field"><label>Shelf Life Value</label>
        <input id="sl-val" class="sc-input" type="number" min="0" step="1" value="${sku.shelf_life_value != null ? esc(String(sku.shelf_life_value)) : ''}" placeholder="e.g. 12"></div>
      <div class="sc-field"><label>Shelf Life Unit</label>
        <select id="sl-unit" class="sc-select"><option value="">—</option>${unitOpt}</select></div>
      <div class="sc-field"><label>Minimum Remaining Shelf Life % (receiving)</label>
        <input id="sl-min" class="sc-input" type="number" min="0" max="100" step="1" value="${sku.min_remaining_shelf_life_pct != null ? esc(String(sku.min_remaining_shelf_life_pct)) : ''}" placeholder="e.g. 70"></div>
    </div>`, [
    { label: 'Cancel', cls: 'ghost' },
    {
      label: 'Save', cls: 'primary', onClick: async () => {
        const val = document.getElementById('sl-val').value;
        const unit = document.getElementById('sl-unit').value;
        const min = document.getElementById('sl-min').value;
        try {
          await updateShelfLife(sku.id, { shelf_life_value: val, shelf_life_unit: unit, min_remaining_shelf_life_pct: min });
          sku.shelf_life_value = val === '' ? null : Number(val);
          sku.shelf_life_unit = unit || null;
          sku.min_remaining_shelf_life_pct = min === '' ? null : Number(min);
          toast('Shelf life updated for ' + sku.item_code, 'ok');
          if (onSaved) onSaved();
        } catch (e) { toast('Save failed: ' + (e.message || e), 'err'); }
      },
    },
  ]);
}
