// SKU Master — the single source of truth for the Roshen catalogue. Full
// management: add / edit / activate / deactivate, search + status filter, and
// per-SKU audit history. The Shelf-Life import (view=import) only UPDATES
// existing SKUs. Pages talk only to services.
import { mount, delegate } from '../../utils/dom.js';
import { esc, money } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import {
  listSkus, createSku, updateSku, setSkuStatus, listSkuAudit,
  getSkuDetail, addSkuBarcode, removeSkuBarcode, addSkuSupplier, removeSkuSupplier,
  addSkuAttachment, getSkuAttachment, removeSkuAttachment,
} from '../../services/sku/sku.service.js';
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
          <button class="sc-btn sm ghost" data-act="detail" data-id="${s.id}">Master data</button>
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
    detail: ({ id }) => openDetail(CACHE.find((s) => String(s.id) === String(id))),
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
      <div class="sc-field"><label>Primary Barcode</label><input id="f-barcode" class="sc-input" value="${esc(v.barcode || '')}" placeholder="EAN-13"></div>
      <div class="sc-field"><label>Brand</label><input id="f-brand" class="sc-input" value="${esc(v.brand || '')}" placeholder="e.g. Roshen"></div>
      <div class="sc-field"><label>Category</label><input id="f-cat" class="sc-input" value="${esc(v.category || '')}" placeholder="e.g. Confectionery"></div>
      <div class="sc-field"><label>Sub Category</label><input id="f-subcat" class="sc-input" value="${esc(v.sub_category || '')}" placeholder="e.g. Wafers"></div>
      <div class="sc-field"><label>Product Family</label><input id="f-family" class="sc-input" value="${esc(v.product_family || '')}" placeholder="e.g. Johnny Krocker"></div>
      <div class="sc-field"><label>Variant / Flavor</label><input id="f-variant" class="sc-input" value="${esc(v.variant_flavor || '')}" placeholder="e.g. Choco"></div>
    </div>
    <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">Every change creates a new version (see History). Historical documents keep the values from when they were created — editing a SKU never rewrites past transactions. Additional barcodes, suppliers and attachments are managed under "Master data".</p>`, [
    { label: isNew ? 'Create SKU' : 'Save changes', cls: 'primary', onClick: async () => {
        const g = (id) => (document.getElementById(id) || {}).value;
        const patch = { roshen_id: g('f-roshen'), item_code: g('f-code'), item_description: g('f-desc'),
          unit_weight_g: g('f-weight'), units_per_carton: g('f-units'), price_case: g('f-price'),
          shelf_life_value: g('f-slv'), shelf_life_unit: g('f-slu'), min_remaining_shelf_life_pct: g('f-min'), status: g('f-status'),
          barcode: g('f-barcode'), brand: g('f-brand'), category: g('f-cat'), sub_category: g('f-subcat'),
          product_family: g('f-family'), variant_flavor: g('f-variant') };
        try {
          if (isNew) { await createSku(patch, ACTOR); toast('SKU created', 'ok'); }
          else { await updateSku(sku.id, patch, ACTOR); toast('SKU updated', 'ok'); }
          onSaved();
        } catch (e) { toast((isNew ? 'Create' : 'Save') + ' failed: ' + (e.message || e), 'err'); }
      } },
    { label: 'Cancel', cls: 'ghost' },
  ]);
}

// Master data — multiple barcodes, suppliers (supplier-specific item codes),
// images / spec PDFs, and the immutable version history.
const readAsBase64 = (file) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',').pop()); r.onerror = rej; r.readAsDataURL(file); });

async function openDetail(sku) {
  if (!sku) return;
  modal(`Master data · ${esc(sku.item_code)} <span class="sc-badge none">v${esc(String(sku.version || 1))}</span>`, '<div data-el="skudetail">Loading…</div>', [{ label: 'Close', cls: 'ghost' }]);
  const paint = async () => {
    const el = document.querySelector('[data-el="skudetail"]');
    if (!el) return;
    let d;
    try { d = await getSkuDetail(sku.id); } catch (e) { el.innerHTML = `<p style="color:var(--text-secondary)">${esc(e.message || String(e))}</p>`; return; }
    el.innerHTML = `
      <div class="sc-card-h" style="margin-top:2px"><h3>🏷 Barcodes</h3></div>
      ${d.barcodes.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.barcodes.map((b) => `<tr>
        <td class="mono">${esc(b.barcode)}</td><td>${esc(b.kind || '')}</td><td>${b.is_primary ? '<span class="sc-badge confirmed">primary</span>' : ''}</td>
        <td style="text-align:right"><button class="sc-btn sm ghost" data-x="rmbarcode" data-id="${b.id}">✖</button></td></tr>`).join('')}</tbody></table>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No additional barcodes.</p>'}
      <div style="display:flex;gap:8px;margin-top:8px"><input class="sc-input sm" data-el="nb" placeholder="Add barcode…" style="max-width:200px">
        <button class="sc-btn sm ghost" data-x="addbarcode">＋ Add</button></div>
      <div class="sc-card-h" style="margin-top:16px"><h3>🚚 Suppliers</h3></div>
      ${d.suppliers.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.suppliers.map((s) => `<tr>
        <td><b>${esc(s.supplier)}</b></td><td class="mono">${esc(s.supplier_item_code || '—')}</td><td>${s.is_default ? '<span class="sc-badge confirmed">default</span>' : ''}</td>
        <td style="text-align:right"><button class="sc-btn sm ghost" data-x="rmsupplier" data-id="${s.id}">✖</button></td></tr>`).join('')}</tbody></table>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No suppliers linked.</p>'}
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input class="sc-input sm" data-el="ns" placeholder="Supplier name…" style="max-width:180px">
        <input class="sc-input sm" data-el="nsc" placeholder="Supplier item code…" style="max-width:170px">
        <button class="sc-btn sm ghost" data-x="addsupplier">＋ Add</button></div>
      <div class="sc-card-h" style="margin-top:16px"><h3>📎 Images & attachments</h3></div>
      ${d.attachments.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.attachments.map((a) => `<tr>
        <td>${a.kind === 'image' ? '🖼' : '📄'} ${esc(a.filename || a.kind)}</td><td style="font-size:11px;color:var(--text-muted)">${a.byte_size ? Math.round(a.byte_size / 1024) + ' KB' : ''}</td>
        <td style="text-align:right"><button class="sc-btn sm ghost" data-x="viewatt" data-id="${a.id}">View</button>
        <button class="sc-btn sm ghost" data-x="rmatt" data-id="${a.id}">✖</button></td></tr>`).join('')}</tbody></table>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No images or attachments.</p>'}
      <label class="sc-btn sm ghost" style="margin-top:8px;display:inline-block;cursor:pointer">📤 Upload image / PDF<input type="file" accept="image/*,.pdf" data-el="natt" style="display:none"></label>
      <div class="sc-card-h" style="margin-top:16px"><h3>🕓 Versions</h3><div class="sc-spacer"></div><span class="sc-badge none">${d.versions.length}</span></div>
      ${d.versions.length ? `<p style="font-size:12px;color:var(--text-secondary);margin:0">${d.versions.map((vv) => 'v' + vv.version).join(' · ')} — each version stores the full SKU as it was before the change.</p>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No changes since creation (v1 is current).</p>'}`;

    const q = (sel) => el.querySelector(sel);
    el.querySelectorAll('[data-x]').forEach((btn) => btn.addEventListener('click', async () => {
      const act = btn.dataset.x, id = btn.dataset.id;
      try {
        if (act === 'addbarcode') { await addSkuBarcode(sku.id, { barcode: q('[data-el="nb"]').value }, ACTOR); toast('Barcode added', 'ok'); }
        else if (act === 'rmbarcode') { await removeSkuBarcode(Number(id), sku.id, ACTOR); toast('Barcode removed', 'ok'); }
        else if (act === 'addsupplier') { await addSkuSupplier(sku.id, { supplier: q('[data-el="ns"]').value, supplier_item_code: q('[data-el="nsc"]').value }, ACTOR); toast('Supplier linked', 'ok'); }
        else if (act === 'rmsupplier') { await removeSkuSupplier(Number(id), sku.id, ACTOR); toast('Supplier removed', 'ok'); }
        else if (act === 'rmatt') { await removeSkuAttachment(Number(id), sku.id, ACTOR); toast('Attachment removed', 'ok'); }
        else if (act === 'viewatt') {
          const doc = await getSkuAttachment(Number(id));
          if (!doc || !doc.data) return toast('No file stored', 'info');
          const bin = atob(doc.data); const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const url = URL.createObjectURL(new Blob([bytes], { type: doc.mime || 'application/octet-stream' }));
          window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
          return;
        }
        paint();
      } catch (e) { toast(e.message || String(e), 'err'); }
    }));
    const fileInput = q('[data-el="natt"]');
    if (fileInput) fileInput.addEventListener('change', async () => {
      const f = fileInput.files && fileInput.files[0]; if (!f) return;
      try {
        const base64 = await readAsBase64(f);
        await addSkuAttachment(sku.id, { kind: f.type === 'application/pdf' ? 'spec_pdf' : 'image', filename: f.name, mime: f.type, size: f.size, base64 }, ACTOR);
        toast('Attachment uploaded', 'ok'); paint();
      } catch (e) { toast(e.message || String(e), 'err'); }
    });
  };
  paint();
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
