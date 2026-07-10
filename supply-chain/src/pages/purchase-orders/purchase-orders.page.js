// Purchase Orders — create / edit / view a purchase order.
// UI only; all persistence goes through the orders service.
import { mount, delegate, qs } from '../../utils/dom.js';
import { esc, money, qty, today } from '../../utils/format.js';
import { orderBadge, piBadge, tableWrap, loading } from '../../components/table/table.js';
import { field, createSkuCombo } from '../../components/forms/forms.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { one } from '../../services/supabase/client.js';
import { listSkus, indexByCode } from '../../services/sku/sku.service.js';
import * as Orders from '../../services/purchase-orders/orders.service.js';
import { getFulfillmentWithSummary } from '../../services/fulfillment/fulfillment.service.js';
import { printOrder, exportOrderExcel } from '../../utils/documents.js';
import { ORDER_STATUS } from '../../models/order-status.js';

let SKUS = [], SKU_BY_CODE = {};
const ED = { id: null, readonly: false, header: null, lines: [], pi: null };
let ROOT = null, CTX = null;

export async function render(root, ctx) {
  ROOT = root; CTX = ctx;
  if (!SKUS.length) { try { SKUS = await listSkus(); SKU_BY_CODE = indexByCode(SKUS); } catch (e) { /* combobox will be empty */ } }
  delegate(root, ACTIONS);
  const p = ctx.params || {};
  if (p.orderId) await openOrder(p.orderId, p.mode || 'view');
  else if (p.duplicateFrom) await duplicateOrder(p.duplicateFrom);
  else startNew();
}

function startNew() {
  ED.id = null; ED.readonly = false; ED.pi = null;
  ED.header = { order_number: '', order_date: today(), supplier: 'Roshen', warehouse: '', expected_arrival: '', notes: '', status: ORDER_STATUS.DRAFT };
  ED.lines = [];
  paint();
}
async function openOrder(id, mode) {
  mount(ROOT, loading());
  let data; try { data = await Orders.getOrder(id); } catch (e) { toast('Load failed: ' + e.message, 'err'); return; }
  ED.id = data.id; ED.pi = one(data.proforma_invoices);
  ED.readonly = mode === 'view' || data.status !== ORDER_STATUS.DRAFT;
  ED.header = { order_number: data.order_number, order_date: data.order_date, supplier: data.supplier, warehouse: data.warehouse || '', expected_arrival: data.expected_arrival || '', notes: data.notes || '', status: data.status };
  ED.lines = (data.supply_order_items || []).slice().sort((a, b) => a.id - b.id)
    .map((it) => ({ item_code: it.item_code, roshen_id: it.roshen_id, item_description: it.item_description, price_case: Number(it.price_case), ordered_cases: Number(it.ordered_cases) }));
  paint();
}
async function duplicateOrder(id) {
  mount(ROOT, loading());
  let data; try { data = await Orders.getOrder(id); } catch (e) { toast('Load failed: ' + e.message, 'err'); return; }
  ED.id = null; ED.readonly = false; ED.pi = null;
  ED.header = { order_number: '', order_date: today(), supplier: data.supplier, warehouse: data.warehouse || '', expected_arrival: '', notes: data.notes || '', status: ORDER_STATUS.DRAFT };
  ED.lines = (data.supply_order_items || []).slice().sort((a, b) => a.id - b.id)
    .map((it) => ({ item_code: it.item_code, roshen_id: it.roshen_id, item_description: it.item_description, price_case: Number(it.price_case), ordered_cases: Number(it.ordered_cases) }));
  paint();
  toast('Duplicated — review and save as a new draft', 'info');
}

function pseudoOrder() {
  return { order_number: ED.header.order_number, order_date: ED.header.order_date, supplier: ED.header.supplier, warehouse: ED.header.warehouse, expected_arrival: ED.header.expected_arrival, status: ED.header.status, supply_order_items: ED.lines };
}

function paint() {
  const h = ED.header, ro = ED.readonly, isNew = ED.id == null, dis = ro ? 'disabled' : '';
  let banner = '';
  if (ro && h.status !== ORDER_STATUS.DRAFT)
    banner = `<div class="sc-locked-banner">🔒 This purchase order is <b>&nbsp;${esc(h.status)}&nbsp;</b> and locked — it is the reference document for its Proforma Invoice.</div>`;
  else if (ro)
    banner = `<div class="sc-locked-banner" style="background:rgba(143,163,189,.12);border-color:var(--border);color:var(--text-secondary)">👁 View mode <button class="sc-btn sm" style="margin-left:6px" data-act="unlock">✏️ Edit</button></div>`;

  let piStrip = '';
  if (ED.pi) piStrip = `<div class="sc-card" style="padding:12px 16px"><div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;font-size:12.5px">
    <div><span class="erp-mini">PI Number</span><br><b>${esc(ED.pi.pi_number || '—')}</b></div>
    <div><span class="erp-mini">PI Date</span><br><b>${esc(ED.pi.pi_date || '—')}</b></div>
    <div><span class="erp-mini">PI Status</span><br>${piBadge(ED.pi.status)}</div>
    <div><span class="erp-mini">Import Date</span><br><b>${esc((ED.pi.imported_at || '').slice(0, 10) || '—')}</b></div>
    <button class="sc-btn sm" style="margin-left:auto" data-act="openPI">🧾 Open Validation Report</button></div></div>`;

  mount(ROOT, `
    <div class="sc-card-h"><h3>${isNew ? '➕ New Purchase Order' : '📄 Purchase Order ' + esc(h.order_number)}</h3>
      <div class="sc-spacer"></div>${orderBadge(h.status)}
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Back to Orders</button></div>
    ${banner}
    <div class="sc-card"><div class="sc-form-grid">
      ${field('Order Number', `<input class="sc-input" readonly value="${esc(isNew ? '(auto-generated on save)' : h.order_number)}">`)}
      ${field('Order Date', `<input data-el="order_date" type="date" class="sc-input" ${dis} value="${esc(h.order_date || '')}">`)}
      ${field('Supplier', `<input data-el="supplier" class="sc-input" ${dis} value="${esc(h.supplier || 'Roshen')}">`)}
      ${field('Warehouse', `<input data-el="warehouse" class="sc-input" ${dis} placeholder="e.g. Jeddah DC" value="${esc(h.warehouse || '')}">`)}
      ${field('Expected Arrival', `<input data-el="expected_arrival" type="date" class="sc-input" ${dis} value="${esc(h.expected_arrival || '')}">`)}
      ${field('Notes', `<input data-el="notes" class="sc-input" ${dis} placeholder="Optional" value="${esc(h.notes || '')}">`)}
    </div></div>
    ${piStrip}
    <div data-el="receiving"></div>
    <div class="sc-card">
      <div class="sc-card-h"><h3>📦 Order Details</h3><div class="sc-spacer"></div>${ro ? '' : '<div data-el="combo" style="min-width:340px"></div>'}</div>
      <div data-el="lines"></div>
      <div class="sc-summary" data-el="summary"></div>
    </div>
    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" data-el="actions"></div>`);

  if (!ro) createSkuCombo(qs('[data-el="combo"]', ROOT), SKUS, addItem);
  renderLines();
  renderActions();
  if (!isNew && h.status !== ORDER_STATUS.DRAFT) renderReceivingProgress();
}

// Live receiving progress — the PO is the source of truth; ordered / received /
// remaining derive from the fulfillment ledger and update on every reload.
async function renderReceivingProgress() {
  const el = qs('[data-el="receiving"]', ROOT);
  if (!el || !ED.id) return;
  let ful;
  try { ful = await getFulfillmentWithSummary(ED.id); } catch (e) { return; }
  if (!ful.rows.length) return;
  const s = ful.summary;
  const pct = s.ordered > 0 ? Math.min(100, Math.round((s.received / s.ordered) * 100)) : 0;
  const bar = (o, r) => {
    const p = o > 0 ? Math.min(100, Math.round((r / o) * 100)) : 0;
    return `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:4px;background:var(--border-light);overflow:hidden">
      <div style="width:${p}%;height:100%;background:${p >= 100 ? '#2FB344' : '#1971C2'}"></div></div><span style="font-size:11px;color:var(--text-muted);min-width:34px">${p}%</span></div>`;
  };
  const rows = ful.rows.map((r) => {
    const ordered = Number(r.ordered_cases || 0), received = Number(r.received_cases || 0);
    const remaining = Number(r.remaining_cases != null ? r.remaining_cases : Math.max(0, ordered - received));
    return `<tr>
      <td class="mono"><b>${esc(r.roshen_id || r.item_code)}</b></td>
      <td>${esc((r.description || '').slice(0, 44))}</td>
      <td class="num">${qty(ordered)}</td>
      <td class="num">${qty(r.delivered_cases)}</td>
      <td class="num"><b>${qty(received)}</b></td>
      <td class="num" style="color:${remaining > 0 ? 'var(--text-primary)' : '#2FB344'}">${qty(remaining)}</td>
      <td style="min-width:120px">${bar(ordered, received)}</td>
      <td>${Number(r.disputed_cases) > 0 ? `<span class="sc-badge closed">${qty(r.disputed_cases)} disputed</span>` : ''}</td></tr>`;
  }).join('');
  el.innerHTML = `<div class="sc-card">
    <div class="sc-card-h"><h3>📦 Receiving Progress</h3><div class="sc-spacer"></div>
      <span style="font-size:12px;color:var(--text-secondary)">Ordered <b>${qty(s.ordered)}</b> · Received <b>${qty(s.received)}</b> · Remaining <b>${qty(s.remaining)}</b> · ${pct}% received</span></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Roshen</th><th>Item</th><th class="num">Ordered</th><th class="num">Delivered</th><th class="num">Received</th><th class="num">Remaining</th><th>Progress</th><th></th></tr></thead><tbody>${rows}</tbody></table>`)}
  </div>`;
}

function renderActions() {
  const h = ED.header, box = qs('[data-el="actions"]', ROOT);
  const isNew = ED.id == null;
  let btns = '';
  if (!ED.readonly) {
    btns += '<button class="sc-btn primary" data-act="save">💾 Save Draft</button>';
    btns += '<button class="sc-btn green" data-act="approve">✅ Approve Order</button>';
    if (isNew) btns += '<button class="sc-btn" data-act="importxl">📥 Import from Excel</button>';
  } else if (h.status === ORDER_STATUS.APPROVED) {
    btns += ED.pi ? '<button class="sc-btn primary" data-act="openPI">🧾 Open PI Validation</button>'
                  : '<button class="sc-btn primary" data-act="import">📥 Import PI</button>';
  } else if (h.status === ORDER_STATUS.PI_IMPORTED || h.status === ORDER_STATUS.PI_APPROVED) {
    if (ED.pi) btns += '<button class="sc-btn primary" data-act="openPI">🧾 Open PI Validation</button>';
    if (h.status === ORDER_STATUS.PI_APPROVED) btns += '<button class="sc-btn" data-act="close">🏁 Close Order</button>';
  }
  if (ED.id) btns += `<div style="margin-left:auto;display:flex;gap:8px">
    <button class="sc-btn ghost" data-act="dup">⧉ Duplicate</button>
    <button class="sc-btn ghost" data-act="print">🖨 Print</button>
    <button class="sc-btn ghost" data-act="xls">⬇ Excel</button></div>`;
  box.innerHTML = btns;
}

function renderLines() {
  const ro = ED.readonly, box = qs('[data-el="lines"]', ROOT);
  if (!ED.lines.length) {
    box.innerHTML = `<div class="sc-empty"><div class="ic">📦</div><p>No items yet.${ro ? '' : ' Search above to add SKUs to this order.'}</p></div>`;
    updateSummary(); return;
  }
  const rows = ED.lines.map((l, i) => {
    const lt = (Number(l.price_case) || 0) * (Number(l.ordered_cases) || 0);
    return `<tr>
      <td>${i + 1}</td><td class="mono">${esc(l.item_code)}</td><td class="mono">${esc(l.roshen_id || '—')}</td>
      <td>${esc(l.item_description || '')}</td><td class="num">${money(l.price_case)}</td>
      <td class="num">${ro ? qty(l.ordered_cases) : `<input class="sc-input sc-qty-input" data-qty="${i}" type="number" min="0" step="1" value="${esc(l.ordered_cases)}">`}</td>
      <td class="num" data-lt="${i}"><b>${money(lt)}</b></td>
      ${ro ? '' : `<td class="num"><button class="sc-row-remove" title="Remove" data-act="removeLine" data-id="${i}">×</button></td>`}
    </tr>`;
  }).join('');
  box.innerHTML = tableWrap(`<table class="sc-table"><thead><tr><th>#</th><th>Item Code</th><th>Roshen ID</th><th>Description</th><th class="num">Price / Case (SAR)</th><th class="num">Ordered Cases</th><th class="num">Line Total (SAR)</th>${ro ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table>`);
  box.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('input', () => onQty(+inp.dataset.qty, inp)));
  updateSummary();
}

function onQty(i, inp) {
  let v = parseFloat(inp.value); if (isNaN(v)) v = '';
  ED.lines[i].ordered_cases = v;
  const lt = (Number(ED.lines[i].price_case) || 0) * (Number(v) || 0);
  const cell = qs(`[data-lt="${i}"]`, ROOT); if (cell) cell.innerHTML = `<b>${money(lt)}</b>`;
  updateSummary();
}

function updateSummary() {
  let cases = 0, total = 0;
  ED.lines.forEach((l) => { cases += Number(l.ordered_cases) || 0; total += (Number(l.price_case) || 0) * (Number(l.ordered_cases) || 0); });
  const box = qs('[data-el="summary"]', ROOT); if (!box) return;
  box.innerHTML = `
    <div class="sc-sum-card"><div class="lbl">Number of Items</div><div class="val">${ED.lines.length}</div></div>
    <div class="sc-sum-card"><div class="lbl">Total Cases</div><div class="val">${qty(cases)}</div></div>
    <div class="sc-sum-card grand"><div class="lbl">Grand Total (SAR)</div><div class="val">${money(total)}</div></div>`;
}

function addItem(code) {
  const sku = SKU_BY_CODE[code]; if (!sku) return;
  const existing = ED.lines.find((l) => l.item_code === code);
  if (existing) {
    modal('Duplicate item',
      `<b>${esc(sku.item_code)}</b> — ${esc(sku.item_description)} is already in this order (current quantity <b>${qty(existing.ordered_cases)}</b> cases).<br><br>Merge the quantity (add one case) or keep a single line?`,
      [{ label: 'Merge (+1 case)', cls: 'primary', onClick: () => { existing.ordered_cases = (Number(existing.ordered_cases) || 0) + 1; renderLines(); toast('Quantity merged', 'ok'); } },
       { label: 'Cancel (no duplicate)', cls: 'ghost' }]);
    return;
  }
  ED.lines.push({ item_code: sku.item_code, roshen_id: sku.roshen_id, item_description: sku.item_description, price_case: Number(sku.price_case), ordered_cases: 1 });
  renderLines();
}

function validate() {
  if (!ED.lines.length) { toast('Add at least one item before saving', 'err'); return false; }
  const seen = {};
  for (let i = 0; i < ED.lines.length; i++) {
    const l = ED.lines[i];
    if (!(Number(l.ordered_cases) > 0)) { toast(`Quantity must be greater than zero — line ${i + 1} (${l.item_code})`, 'err'); return false; }
    if (seen[l.item_code]) { toast('Duplicate SKU in order: ' + l.item_code, 'err'); return false; }
    seen[l.item_code] = true;
  }
  return true;
}

async function save(thenApprove) {
  if (!validate()) return;
  const header = {
    order_date: qs('[data-el="order_date"]', ROOT).value || today(),
    supplier: (qs('[data-el="supplier"]', ROOT).value || 'Roshen').trim(),
    warehouse: qs('[data-el="warehouse"]', ROOT).value.trim() || null,
    expected_arrival: qs('[data-el="expected_arrival"]', ROOT).value || null,
    notes: qs('[data-el="notes"]', ROOT).value.trim() || null,
  };
  try {
    if (ED.id == null) {
      const row = await Orders.createOrder(header);
      ED.id = row.id; ED.header.order_number = row.order_number; ED.header.status = row.status;
    } else {
      await Orders.updateHeader(ED.id, header);
    }
    await Orders.replaceItems(ED.id, ED.lines.map((l) => ({
      item_code: l.item_code, roshen_id: l.roshen_id, item_description: l.item_description,
      ordered_cases: Number(l.ordered_cases), price_case: Number(l.price_case),
    })));
  } catch (e) { toast('Save failed: ' + (e.message || e), 'err'); return; }

  if (thenApprove) confirmApprove();
  else { toast('Draft saved · ' + ED.header.order_number, 'ok'); paint(); }
}

function confirmApprove() {
  modal('Approve purchase order?',
    'Approving locks the order from further editing and makes it the official reference document for the imported Proforma Invoice. Continue?',
    [{ label: 'Approve & Lock', cls: 'green', onClick: async () => {
        try { await Orders.approve(ED.id); } catch (e) { toast('Approve failed: ' + e.message, 'err'); return; }
        toast('Order approved & locked', 'ok'); await openOrder(ED.id, 'view');
      } }, { label: 'Cancel', cls: 'ghost' }]);
}

const ACTIONS = {
  back: () => CTX.navigate('order-history'),
  importxl: () => CTX.navigate('import-order'),
  unlock: () => { if (ED.header.status === ORDER_STATUS.DRAFT) { ED.readonly = false; paint(); } },
  save: () => save(false),
  approve: () => save(true),
  openPI: () => CTX.navigate('validation', { piId: ED.pi && ED.pi.id }),
  import: () => CTX.navigate('pi-import', { orderId: ED.id }),
  dup: () => CTX.navigate('purchase-orders', { duplicateFrom: ED.id }),
  removeLine: (d) => { ED.lines.splice(+d.id, 1); renderLines(); },
  print: () => { if (!printOrder(pseudoOrder())) toast('Allow pop-ups to print', 'err'); },
  xls: () => { exportOrderExcel(pseudoOrder()); toast('Exported', 'ok'); },
  close: () => modal('Close order?', 'Mark this order as Closed — this completes the Purchase Order → PI lifecycle.',
    [{ label: 'Close Order', cls: 'primary', onClick: async () => { try { await Orders.setStatus(ED.id, ORDER_STATUS.CLOSED); } catch (e) { toast(e.message, 'err'); return; } toast('Order closed', 'ok'); await openOrder(ED.id, 'view'); } }, { label: 'Cancel', cls: 'ghost' }]),
};
