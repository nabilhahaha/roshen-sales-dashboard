// Batch Tracking — the Batch/Lot Master module. Every received batch is a
// first-class record (created automatically by Goods Receipt) with live
// movement-derived stock, dynamic shelf life, QC + hold state, reservations,
// a full audit trail, and a FEFO allocation tool that always draws from the
// oldest valid batch. Pages talk only to services.
import { mount, delegate, qsa } from '../../utils/dom.js';
import { esc, qty, today } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { qcBadge, shelfChip } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import { listBatchStock, getBatch, holdBatch, unholdBatch, adjustBatchStock, allocateFefo } from '../../services/batch/batch.service.js';

const ACTOR = 'Development';
let CACHE = [];

const skuOf = (b) => ({ shelf_life_value: b.shelf_life_value, shelf_life_unit: b.shelf_life_unit, min_remaining_shelf_life_pct: b.min_remaining_shelf_life_pct });
const holdChip = (b) => (b.hold_status === 'on_hold' ? `<span class="sc-badge closed" title="${esc(b.hold_reason || '')}">ON HOLD</span>` : '');

export async function render(root, ctx) {
  mount(root, loading('Loading batches…'));
  try { CACHE = await listBatchStock(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const inStock = CACHE.filter((b) => Number(b.current_cases) > 0);
  mount(root, `
    <div class="sc-card-h"><h3>🔖 Batch Tracking</h3>
      <span class="sc-badge none" style="margin-left:8px">${CACHE.length} batches · ${inStock.length} in stock</span>
      <div class="sc-spacer"></div>
      <label style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;cursor:pointer">
        <input type="checkbox" data-el="stockonly"> in stock only</label>
      <input class="sc-input" style="max-width:220px;margin-left:10px" data-el="search" placeholder="🔎 Batch / SKU / warehouse…">
      <button class="sc-btn primary" style="margin-left:8px" data-act="fefo">📤 FEFO Allocation</button></div>
    <div class="sc-card">
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Every received batch is a Batch Master record created automatically by Goods Receipt. Stock is tracked by SKU + batch (movement-derived); shelf life is calculated live; QC and holds apply per batch; FEFO always allocates from the oldest valid batch.</p>
      <div data-el="body"></div>
    </div>`);

  const body = root.querySelector('[data-el="body"]');
  const search = root.querySelector('[data-el="search"]');
  const stockOnly = root.querySelector('[data-el="stockonly"]');

  const paint = (list) => {
    const rows = list.map((b) => {
      const sl = shelfLife(skuOf(b), { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
      return `<tr class="sc-row-link" data-act="open" data-id="${b.id}">
        <td class="mono"><b>#${b.id}</b><div style="font-size:11px;color:var(--text-muted)">${esc(b.batch_no || '—')}</div></td>
        <td><b class="mono">${esc(b.roshen_id || b.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc((b.item_description || '').slice(0, 38))}</div></td>
        <td>${esc(b.warehouse || '—')}</td>
        <td>${esc(b.received_date || '—')}</td>
        <td>${esc(b.expiry_date || '—')}</td>
        <td>${shelfChip(sl)}</td>
        <td>${qcBadge(b.qc_status)} ${holdChip(b)}</td>
        <td class="num"><b>${qty(b.current_cases)}</b></td>
        <td class="num">${Number(b.reserved_cases) ? qty(b.reserved_cases) : '—'}</td>
        <td class="num">${qty(b.available_cases)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:22px">No batches yet — they are created automatically when goods are received.</td></tr>';
    body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr>
      <th>Batch</th><th>SKU</th><th>Warehouse</th><th>Received</th><th>Expiry</th><th>Shelf Life</th>
      <th>QC / Hold</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Available</th></tr></thead>
      <tbody>${rows}</tbody></table>`);
  };
  const applyFilter = () => {
    const q = (search.value || '').trim().toLowerCase();
    let list = stockOnly.checked ? CACHE.filter((b) => Number(b.current_cases) > 0) : CACHE;
    if (q) list = list.filter((b) => String(b.id).includes(q) || (b.batch_no || '').toLowerCase().includes(q) ||
      (b.item_code || '').toLowerCase().includes(q) || String(b.roshen_id || '').includes(q) ||
      (b.item_description || '').toLowerCase().includes(q) || (b.warehouse || '').toLowerCase().includes(q));
    paint(list);
  };
  const reload = async () => { CACHE = await listBatchStock(); applyFilter(); };

  delegate(root, {
    open: ({ id }) => openBatchDetail(Number(id), reload),
    fefo: () => openFefoModal(),
  });
  search.addEventListener('input', applyFilter);
  stockOnly.addEventListener('change', applyFilter);
  applyFilter();
  ctx.pageSearch = (q) => { search.value = q || ''; applyFilter(); };
}

// ---- batch detail: traceability + movements + audit + actions ---------
const BAUDIT = { created: '➕ Created', qc_released: '✅ QC Released', qc_rejected: '⛔ QC Rejected', qc_reset: '↺ QC Reset',
  held: '✋ Put on hold', unheld: '▶ Hold released', released: '📦 Stock posted', reversed: '↩ Reversed',
  adjusted: '⚖ Adjusted', reserved: '🔒 Reserved', unreserved: '🔓 Unreserved' };

async function openBatchDetail(batchId, onChange) {
  modal(`Batch #${batchId}`, '<div data-el="bd">Loading…</div>', [{ label: 'Close', cls: 'ghost' }]);
  let b;
  try { b = await getBatch(batchId); } catch (e) { const el = document.querySelector('[data-el="bd"]'); if (el) el.textContent = e.message || String(e); return; }
  const el = document.querySelector('[data-el="bd"]');
  if (!el) return;
  const sl = shelfLife(skuOf(b), { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
  const kv = (k, v) => `<div style="font-size:12px"><span style="color:var(--text-muted);font-size:10.5px;text-transform:uppercase;display:block">${k}</span><b>${v}</b></div>`;
  el.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
      ${kv('SKU', esc(b.roshen_id || b.item_code) + ' · ' + esc((b.item_description || '').slice(0, 30)))}
      ${kv('Batch / Supplier batch', esc(b.batch_no || '—') + ' / ' + esc(b.supplier_batch_no || '—'))}
      ${kv('Warehouse', esc(b.warehouse || '—'))}
      ${kv('Mfg / Expiry', esc(b.manufacturing_date || '—') + ' → ' + esc(b.expiry_date || '—'))}
      ${kv('Shelf life', shelfChip(sl))}
      ${kv('QC / Hold', qcBadge(b.qc_status) + ' ' + holdChip(b))}
      ${kv('On hand', qty(b.current_cases))} ${kv('Reserved', qty(b.reserved_cases))} ${kv('Available', qty(b.available_cases))}
      ${kv('Received', esc(b.received_date || '—'))}
      ${kv('Released at', esc(String(b.released_at || '—').slice(0, 16).replace('T', ' ')))}
      ${kv('Source', 'PO #' + esc(String(b.order_id || '—')) + ' · GRN batch #' + esc(String(b.gr_batch_id || '—')))}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
      ${b.hold_status === 'on_hold' ? '<button class="sc-btn sm ghost" data-b="unhold">▶ Release hold</button>' : '<button class="sc-btn sm ghost" data-b="hold">✋ Put on hold</button>'}
      <button class="sc-btn sm ghost" data-b="adjust">⚖ Adjust stock</button></div>
    <div class="sc-card-h" style="margin-top:14px"><h3>📜 Movements (${b.movements.length})</h3></div>
    ${b.movements.length ? `<table class="sc-table" style="min-width:0"><tbody>${b.movements.map((m) => `<tr>
      <td>${esc(String(m.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(m.movement_type)}</td>
      <td class="num" style="color:${Number(m.cases_delta) < 0 ? '#E03131' : '#2FB344'}"><b>${Number(m.cases_delta) > 0 ? '+' : ''}${qty(m.cases_delta)}</b></td>
      <td style="font-size:11px;color:var(--text-muted)">${esc(m.reference || '')}</td></tr>`).join('')}</tbody></table>` : '<p style="font-size:12px;color:var(--text-muted);margin:0">No stock movements yet.</p>'}
    <div class="sc-card-h" style="margin-top:14px"><h3>🕓 Audit (${b.audit.length})</h3></div>
    <div class="erp-rev-timeline">${b.audit.map((a) => `<div class="erp-rev"><div class="erp-rev-h"><b>${esc(BAUDIT[a.action] || a.action)}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(a.actor || '—')} · ${esc(String(a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      ${a.note ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(a.note)}</div>` : ''}</div>`).join('') || '<p style="font-size:12px;color:var(--text-muted)">—</p>'}</div>`;

  el.querySelectorAll('[data-b]').forEach((btn) => btn.addEventListener('click', async () => {
    const act = btn.dataset.b;
    try {
      if (act === 'hold') { const r = prompt('Hold reason (e.g. quality investigation / recall):') || null; await holdBatch(batchId, { reason: r, actor: ACTOR }); toast('Batch on hold — excluded from FEFO', 'info'); }
      else if (act === 'unhold') { await unholdBatch(batchId, { actor: ACTOR }); toast('Hold released', 'ok'); }
      else if (act === 'adjust') {
        const v = prompt('Adjustment in cases (negative to write off, positive to correct up):');
        if (v == null || v === '' || !Number(v)) return;
        const reason = prompt('Reason for the adjustment:') || null;
        await adjustBatchStock(batchId, Number(v), { reason, actor: ACTOR });
        toast('Stock adjusted by ' + v, 'ok');
      }
      openBatchDetail(batchId, onChange); if (onChange) onChange();
    } catch (e) { toast(e.message || String(e), 'err'); }
  }));
}

// ---- FEFO allocation preview ------------------------------------------
function openFefoModal() {
  const skus = {};
  CACHE.forEach((b) => { if (!skus[b.sku_id]) skus[b.sku_id] = b; });
  const opts = Object.values(skus).map((b) => `<option value="${b.sku_id}">${esc(b.roshen_id || b.item_code)} · ${esc((b.item_description || '').slice(0, 40))}</option>`).join('');
  modal('📤 FEFO Allocation', `
    <p style="font-size:12px;color:var(--text-secondary);margin-top:0">Preview which batches an order of N cases would draw from. FEFO always takes the oldest valid batch first — QC-released, not on hold, not expired, with available stock.</p>
    <div class="sc-form-grid">
      <div class="sc-field" style="grid-column:1/-1"><label>SKU</label><select id="fefo-sku" class="sc-select">${opts}</select></div>
      <div class="sc-field"><label>Cases needed</label><input id="fefo-qty" class="sc-input" type="number" min="1" value="10"></div>
    </div>
    <div style="margin-top:10px"><button class="sc-btn primary sm" id="fefo-run">Preview allocation</button></div>
    <div id="fefo-out" style="margin-top:12px"></div>`, [{ label: 'Close', cls: 'ghost' }]);
  const runBtn = document.getElementById('fefo-run');
  if (!runBtn) return;
  runBtn.addEventListener('click', () => {
    const skuId = Number((document.getElementById('fefo-sku') || {}).value);
    const need = Number((document.getElementById('fefo-qty') || {}).value || 0);
    const rows = CACHE.filter((b) => b.sku_id === skuId);
    const plan = allocateFefo(rows, need);
    const out = document.getElementById('fefo-out');
    if (!out) return;
    out.innerHTML = `
      ${plan.allocations.length ? `<table class="sc-table" style="min-width:0"><thead><tr><th>Order</th><th>Batch</th><th>Expiry</th><th class="num">Take</th><th class="num">Batch available</th></tr></thead>
        <tbody>${plan.allocations.map((a, i) => `<tr><td>${i + 1}</td><td class="mono">#${a.batch.id} · ${esc(a.batch.batch_no || '—')}</td>
        <td>${esc(a.batch.expiry_date || '—')}</td><td class="num"><b>${qty(a.cases)}</b></td><td class="num">${qty(a.batch.available_cases)}</td></tr>`).join('')}</tbody></table>` : ''}
      <p style="font-size:12.5px;margin:8px 0 0;color:${plan.satisfied ? 'var(--text-secondary)' : '#F76707'}">
        ${plan.satisfied ? '✓ Fully allocatable from ' + plan.allocations.length + ' batch(es), oldest expiry first.'
        : '⚠ Short by <b>' + qty(plan.remaining) + '</b> case(s) — no more valid batches (QC-released, not held, not expired).'}</p>`;
  });
}
