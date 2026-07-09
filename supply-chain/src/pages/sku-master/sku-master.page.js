// SKU Master — the single source of truth for the Roshen catalogue. Full
// management: add / edit / activate / deactivate, search + status filter, and
// per-SKU audit history. The Shelf-Life import (view=import) only UPDATES
// existing SKUs. Pages talk only to services.
import { mount, delegate } from '../../utils/dom.js';
import { esc, money } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { listSkus, createSku, updateSku, setSkuStatus, listSkuAudit } from '../../services/sku/sku.service.js';
import { startShelfLifeImport } from './shelf-life-import.flow.js';

const ACTOR = 'Development';
let CACHE = [];

const weightText = (s) => (s.unit_weight_g == null ? '—' : (s.unit_weight_g >= 1000 ? (s.unit_weight_g / 1000) + ' kg' : s.unit_weight_g + ' g'));
const shelfText = (s) => (s.shelf_life_value != null && s.shelf_life_unit ? `${esc(String(s.shelf_life_value))} ${esc(s.shelf_life_unit)}` : '<span style="color:var(--text-muted)">—</span>');
const minText = (s) => (s.min_remaining_shelf_life_pct != null ? `<span class="sc-badge pi">${esc(String(s.min_remaining_shelf_life_pct))}%</span>` : '<span style="color:var(--text-muted)">—</span>');
const statusBadge = (s) => (s.status === 'active' ? '<span class="sc-badge confirmed">active</span>' : `<span class="sc-badge draft">${esc(s.status || 'inactive')}</span>`);

export async function render(root, ctx) {
  const view = (ctx.params && ctx.params.view) || 'list';
  if (view === 'import') return startShelfLifeImport(root, ctx);
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  mount(root, loading('Loading SKU Master…'));
  try { CACHE = await listSkus({ activeOnly: false }); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  mount(root, `
    <div class="sc-card">
      <div class="sc-card-h">
        <h3>🧾 SKU Master</h3>
        <span class="sc-badge none" style="margin-left:8px" data-el="count">${CACHE.length} items</span>
        <div class="sc-spacer"></div>
        <select class="sc-select" style="max-width:130px" data-el="status">
          <option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
        <input class="sc-input" style="max-width:230px;margin-left:8px" data-el="search" placeholder="🔎 Search code / Roshen / description…">
        <button class="sc-btn ghost" style="margin-left:8px" data-act="import">📥 Shelf Life Import</button>
        <button class="sc-btn primary" style="margin-left:8px" data-act="add">＋ Add SKU</button>
      </div>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">SKU Master owns Shelf Life, Unit Weight, Units/Carton, Minimum Receiving % and Status. Every shelf-life calculation across Delivery Notes, Goods Receipt, Inventory, Expiry and FEFO reads these values. All changes are audited.</p>
      <div data-el="body"></div>
    </div>`);

  const body = root.querySelector('[data-el="body"]');
  const search = root.querySelector('[data-el="search"]');
  const statusSel = root.querySelector('[data-el="status"]');

  const paint = (list) => {
    const rows = list.map((s) => `
      <tr>
        <td class="mono">${esc(s.roshen_id || '—')}</td>
        <td class="mono"><b>${esc(s.item_code)}</b></td>
        <td>${esc(s.item_description || '')}</td>
        <td class="num">${esc(weightText(s))}</td>
        <td class="num">${s.units_per_carton == null ? '—' : esc(String(s.units_per_carton))}</td>
        <td class="num">${money(s.price_case)}</td>
        <td>${shelfText(s)}</td>
        <td class="num">${minText(s)}</td>
        <td>${statusBadge(s)}</td>
        <td style="white-space:nowrap">
          <button class="sc-btn sm ghost" data-act="edit" data-id="${s.id}">Edit</button>
          <button class="sc-btn sm ghost" data-act="toggle" data-id="${s.id}">${s.status === 'active' ? 'Deactivate' : 'Activate'}</button>
          <button class="sc-btn sm ghost" data-act="history" data-id="${s.id}">History</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:20px">No matching SKU</td></tr>';
    body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr>
      <th>Roshen ID</th><th>Item Code</th><th>Description</th><th class="num">Weight</th><th class="num">Units/Ctn</th>
      <th class="num">Price / Case</th><th>Shelf Life</th><th class="num">Min Rcv %</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table>`);
  };
  const applyFilter = () => {
    const q = (search.value || '').trim().toLowerCase();
    const st = statusSel.value;
    let list = CACHE;
    if (st !== 'all') list = list.filter((s) => (s.status || 'inactive') === st);
    if (q) list = list.filter((s) => (s.item_code || '').toLowerCase().includes(q) || (s.item_description || '').toLowerCase().includes(q) || String(s.roshen_id || '').includes(q));
    paint(list);
  };
  const reload = async () => { CACHE = await listSkus({ activeOnly: false }); root.querySelector('[data-el="count"]').textContent = CACHE.length + ' items'; applyFilter(); };

  delegate(root, {
    import: () => ctx.navigate('sku-master', { view: 'import' }),
    add: () => openEditor(null, reload),
    edit: ({ id }) => openEditor(CACHE.find((s) => String(s.id) === String(id)), reload),
    toggle: async ({ id }) => {
      const s = CACHE.find((x) => String(x.id) === String(id)); if (!s) return;
      try { await setSkuStatus(s.id, s.status === 'active' ? 'inactive' : 'active', ACTOR); toast('SKU ' + (s.status === 'active' ? 'deactivated' : 'activated'), 'ok'); reload(); }
      catch (e) { toast(e.message || String(e), 'err'); }
    },
    history: ({ id }) => openHistory(CACHE.find((s) => String(s.id) === String(id))),
  });
  search.addEventListener('input', applyFilter);
  statusSel.addEventListener('change', applyFilter);
  if (ctx.params && ctx.params.q) search.value = ctx.params.q;
  applyFilter();
  ctx.pageSearch = (q) => { search.value = q || ''; applyFilter(); };
}

// Add / edit a SKU — every maintainable field.
function openEditor(sku, onSaved) {
  const isNew = !sku;
  const v = sku || {};
  const unitOpt = ['Days', 'Months', 'Years'].map((x) => `<option value="${x}" ${v.shelf_life_unit === x ? 'selected' : ''}>${x}</option>`).join('');
  modal(isNew ? '＋ Add SKU' : `Edit · ${esc(v.item_code)}`, `
    <div class="sc-form-grid">
      <div class="sc-field"><label>Roshen ID</label><input id="f-roshen" class="sc-input" value="${esc(v.roshen_id || '')}"></div>
      <div class="sc-field"><label>Item Code *</label><input id="f-code" class="sc-input" value="${esc(v.item_code || '')}" ${isNew ? '' : ''}></div>
      <div class="sc-field" style="grid-column:1/-1"><label>Item Description *</label><input id="f-desc" class="sc-input" value="${esc(v.item_description || '')}"></div>
      <div class="sc-field"><label>Unit Weight (g)</label><input id="f-weight" class="sc-input" type="number" min="0" step="1" value="${v.unit_weight_g != null ? esc(String(v.unit_weight_g)) : ''}" placeholder="e.g. 350"></div>
      <div class="sc-field"><label>Units / Carton</label><input id="f-units" class="sc-input" type="number" min="0" step="1" value="${v.units_per_carton != null ? esc(String(v.units_per_carton)) : ''}" placeholder="e.g. 12"></div>
      <div class="sc-field"><label>Price / Case</label><input id="f-price" class="sc-input" type="number" min="0" step="0.01" value="${v.price_case != null ? esc(String(v.price_case)) : ''}"></div>
      <div class="sc-field"><label>Shelf Life Value</label><input id="f-slv" class="sc-input" type="number" min="0" step="1" value="${v.shelf_life_value != null ? esc(String(v.shelf_life_value)) : ''}" placeholder="e.g. 12"></div>
      <div class="sc-field"><label>Shelf Life Unit</label><select id="f-slu" class="sc-select"><option value="">—</option>${unitOpt}</select></div>
      <div class="sc-field"><label>Minimum Remaining Shelf Life %</label><input id="f-min" class="sc-input" type="number" min="0" max="100" step="1" value="${v.min_remaining_shelf_life_pct != null ? esc(String(v.min_remaining_shelf_life_pct)) : ''}" placeholder="e.g. 70"></div>
      <div class="sc-field"><label>Status</label><select id="f-status" class="sc-select"><option value="active" ${(v.status || 'active') === 'active' ? 'selected' : ''}>Active</option><option value="inactive" ${v.status === 'inactive' ? 'selected' : ''}>Inactive</option></select></div>
    </div>
    <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">Shelf-life imports update Shelf Life only; the other fields are maintained here and never overwritten by an import.</p>`, [
    { label: isNew ? 'Create SKU' : 'Save changes', cls: 'primary', onClick: async () => {
        const g = (id) => (document.getElementById(id) || {}).value;
        const patch = { roshen_id: g('f-roshen'), item_code: g('f-code'), item_description: g('f-desc'),
          unit_weight_g: g('f-weight'), units_per_carton: g('f-units'), price_case: g('f-price'),
          shelf_life_value: g('f-slv'), shelf_life_unit: g('f-slu'), min_remaining_shelf_life_pct: g('f-min'), status: g('f-status') };
        try {
          if (isNew) { await createSku(patch, ACTOR); toast('SKU created', 'ok'); }
          else { await updateSku(sku.id, patch, ACTOR); toast('SKU updated', 'ok'); }
          onSaved();
        } catch (e) { toast((isNew ? 'Create' : 'Save') + ' failed: ' + (e.message || e), 'err'); }
      } },
    { label: 'Cancel', cls: 'ghost' },
  ]);
}

const AUDIT_LABEL = { created: '➕ Created', updated: '✏️ Updated', activated: '✅ Activated', deactivated: '🚫 Deactivated', shelf_import: '📥 Shelf-life import' };
async function openHistory(sku) {
  if (!sku) return;
  modal(`History · ${esc(sku.item_code)}`, '<div data-el="hist">Loading…</div>', [{ label: 'Close', cls: 'ghost' }]);
  let audit = [];
  try { audit = await listSkuAudit(sku.id); } catch (e) { /* ignore */ }
  const el = document.querySelector('[data-el="hist"]');
  if (!el) return;
  el.innerHTML = audit.length ? `<div class="erp-rev-timeline">${audit.map((a) => {
    const d = a.detail || {};
    let detail = '';
    if (a.action === 'updated' && d.changed) detail = Object.keys(d.changed).map((k) => `${k}: ${fmt(d.changed[k].from)} → ${fmt(d.changed[k].to)}`).join(' · ');
    else if (a.action === 'shelf_import' && d.to) detail = `${fmt(d.from && d.from.value)} ${d.from && d.from.unit || ''} → ${fmt(d.to.value)} ${d.to.unit}`;
    return `<div class="erp-rev"><div class="erp-rev-h"><b>${esc(AUDIT_LABEL[a.action] || a.action)}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(a.actor || '—')} · ${esc(String(a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      ${detail ? `<div style="font-size:11.5px;color:var(--text-secondary)">${esc(detail)}</div>` : ''}</div>`;
  }).join('')}</div>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No changes recorded yet.</p>';
}
const fmt = (x) => (x == null || x === '' ? '—' : String(x));
