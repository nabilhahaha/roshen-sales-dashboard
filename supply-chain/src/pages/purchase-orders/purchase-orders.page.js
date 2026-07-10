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
import { getReceivingDashboard } from '../../services/fulfillment/fulfillment.service.js';
import { statusBadge } from '../../components/table/badges.js';
import { attachmentsPanel } from '../../components/attachments/attachments-panel.js';
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
    banner = `<div class="sc-locked-banner">🔒 This PI is <b>&nbsp;${esc(h.status)}&nbsp;</b> and locked.</div>`;
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
    <div class="sc-card-h"><h3>${isNew ? '➕ New Purchase Invoice (PI)' : '📄 Purchase Invoice (PI) ' + esc(h.order_number)}</h3>
      <div class="sc-spacer"></div>${orderBadge(h.status)}
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← All PIs</button></div>
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
    <div data-el="attachments"></div>
    <div class="sc-card">
      <div class="sc-card-h"><h3>📦 Items</h3><div class="sc-spacer"></div>${ro ? '' : '<div data-el="combo" style="min-width:340px"></div>'}</div>
      <div data-el="lines"></div>
      <div class="sc-summary" data-el="summary"></div>
    </div>
    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" data-el="actions"></div>`);

  if (!ro) createSkuCombo(qs('[data-el="combo"]', ROOT), SKUS, addItem);
  renderLines();
  renderActions();
  if (!isNew && h.status !== ORDER_STATUS.DRAFT) renderReceivingProgress();
  if (!isNew) attachmentsPanel(qs('[data-el="attachments"]', ROOT), 'purchase_order', ED.id, { actor: 'Development' });
}

// PI operational dashboard — the single screen of record for receiving.
// Per line: Ordered / Received (live) / Remaining / % / DN + GR counts / last
// receipt / Open-Partial-Completed status. Clicking a line drills into the
// linked delivery notes, goods receipts and received batches.
let DASH_ROWS = [];
let DASH_SHOW_ALL = false;
async function renderReceivingProgress() {
  const el = qs('[data-el="receiving"]', ROOT);
  if (!el || !ED.id) return;
  let dash;
  try { dash = await getReceivingDashboard(ED.id); } catch (e) { return; }
  if (!dash.rows.length) return;
  DASH_ROWS = dash.rows;
  paintDashboard(el, dash);
}

function paintDashboard(el, dash) {
  const s = dash.summary;
  const pct = s.ordered > 0 ? Math.min(100, Math.round((s.received / s.ordered) * 100)) : 0;
  const completedN = dash.rows.filter((r) => r.line_status === 'Completed').length;
  const hideDone = !DASH_SHOW_ALL && completedN > 0 && completedN < dash.rows.length;
  const visible = hideDone ? dash.rows.filter((r) => r.line_status !== 'Completed') : dash.rows;
  const bar = (p) => `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:4px;background:var(--border-light);overflow:hidden">
      <div style="width:${p}%;height:100%;background:${p >= 100 ? '#2FB344' : '#1971C2'}"></div></div><span style="font-size:11px;color:var(--text-muted);min-width:34px">${p}%</span></div>`;
  const lineChip = (st) => `<span class="sc-badge ${st === 'Completed' ? 'confirmed' : st === 'Partial' ? 'pi' : 'none'}">${esc(st)}</span>`;
  const invChip = (st) => st === '—' ? '' : `<span class="sc-badge ${st === 'Matched' ? 'confirmed' : st === 'Disputed' ? 'closed' : st === 'Partially Matched' ? 'pi' : 'none'}">${esc(st)}</span>`;
  const rows = visible.map((r) => `<tr class="sc-row-link" data-act="drill" data-id="${DASH_ROWS.indexOf(r)}">
      <td class="mono"><b>${esc(r.item_code || '')}</b><div style="font-size:10.5px;color:var(--text-muted)">${esc(String(r.roshen_id || ''))}</div></td>
      <td style="font-size:12px">${esc((r.description || '').slice(0, 36))}</td>
      <td class="num">${qty(r.ordered_cases)}</td>
      <td class="num">${qty(r.delivered_cases)}${Number(r.disputed_cases) > 0 ? `<div style="font-size:10px;color:#F76707">${qty(r.disputed_cases)} disputed</div>` : ''}</td>
      <td class="num"><b>${qty(r.received_cases)}</b></td>
      <td class="num" style="color:${Number(r.remaining_cases) > 0 ? 'var(--text-primary)' : '#2FB344'}"><b>${qty(r.remaining_cases)}</b></td>
      <td style="min-width:100px">${bar(r.pct)}</td>
      <td class="num">${r.dn_count || '—'}</td>
      <td style="font-size:11.5px">${r.last_delivery_at ? esc(String(r.last_delivery_at).slice(0, 10)) : '—'}
        ${r.expected_arrival ? `<div style="font-size:10px;color:var(--text-muted)">next ETA ${esc(String(r.expected_arrival).slice(0, 16).replace('T', ' '))}</div>` : ''}</td>
      <td>${lineChip(r.line_status)} ${invChip(r.invoice_status)}${r.shipment_status !== '—' && r.shipment_status !== 'Received' ? ' ' + statusBadge(r.shipment_status) : ''}</td></tr>`).join('');
  el.innerHTML = `<div class="sc-card">
    <div class="sc-card-h"><h3>📦 Delivery Progress</h3><div class="sc-spacer"></div>
      <span style="font-size:12.5px;color:var(--text-secondary)">Total Ordered <b>${qty(s.ordered)}</b> · Total Received <b>${qty(s.received)}</b> · Remaining <b>${qty(s.remaining)}</b> · Overall <b>${pct}%</b> · ${orderBadge(ED.header.status)}</span></div>
    <div style="display:flex;align-items:center;gap:14px;margin:0 0 8px">
      <p style="font-size:11.5px;color:var(--text-muted);margin:0;flex:1">Click a line to see its deliveries, receipts and batches. The PI closes automatically when everything is received.</p>
      ${completedN > 0 ? `<label style="font-size:11.5px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap">
        <input type="checkbox" data-el="showdone" ${DASH_SHOW_ALL ? 'checked' : ''}> show ${completedN} completed item(s)</label>` : ''}</div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item Code / Roshen</th><th>Description</th><th class="num">Ordered Qty</th><th class="num">Delivered Qty</th><th class="num">Received Qty</th><th class="num">Remaining Qty</th><th>Delivery Progress</th><th class="num">Deliveries</th><th>Last Delivery</th><th>Status</th></tr></thead><tbody>${rows ||
      '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:16px">All items completely received 🎉</td></tr>'}</tbody></table>`)}
  </div>`;
  const toggle = el.querySelector('[data-el="showdone"]');
  if (toggle) toggle.addEventListener('change', () => { DASH_SHOW_ALL = toggle.checked; paintDashboard(el, dash); });
}

function openLineDrill(r) {
  const d = r.drill || { dns: [], grs: [], batches: [] };
  const sec = (title, inner) => `<div class="sc-card-h" style="margin-top:12px"><h3>${title}</h3></div>${inner}`;
  const none = '<p style="font-size:12px;color:var(--text-muted);margin:0">None yet.</p>';
  modal(`${esc(r.roshen_id || r.item_code)} · receiving detail`, `
    <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;margin-bottom:4px">
      <div>Ordered <b>${qty(r.ordered_cases)}</b></div><div>Received <b>${qty(r.received_cases)}</b></div>
      <div>Remaining <b>${qty(r.remaining_cases)}</b></div><div><b>${r.pct}%</b> received</div></div>
    ${sec('🚚 Delivery Notes (' + d.dns.length + ')', d.dns.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.dns.map((x) => `<tr>
      <td class="mono"><b>${esc(x.dn_number)}</b></td><td>${esc(x.dn_date || '—')}</td>
      <td>${statusBadge(x.status)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${x.expected_delivery_at ? 'ETA ' + esc(String(x.expected_delivery_at).slice(0, 16).replace('T', ' ')) : ''}</td>
      <td class="num"><b>${qty(x.cases)}</b> ctn</td></tr>`).join('')}</tbody></table>` : none)}
    ${sec('📦 Warehouse Receipts (' + d.grs.length + ')', d.grs.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.grs.map((x) => `<tr>
      <td class="mono"><b>${esc(x.grn_number)}</b></td><td>${esc((x.released_at || x.receipt_date || '').slice(0, 10))}</td>
      <td>${statusBadge(x.status)}</td><td>${esc(x.warehouse || '—')}</td>
      <td class="num"><b>${qty(x.cases)}</b> received</td></tr>`).join('')}</tbody></table>` : none)}
    ${sec('🔖 Received batches (' + d.batches.length + ')', d.batches.length ? `<table class="sc-table" style="min-width:0"><thead><tr><th>Batch</th><th>Expiry</th><th class="num">Received</th><th class="num">On hand</th><th>QC</th><th>GRN</th></tr></thead><tbody>${d.batches.map((x) => `<tr>
      <td class="mono">${x.batch_id ? '#' + x.batch_id + ' · ' : ''}${esc(x.batch_no || '—')}</td>
      <td>${esc(x.expiry_date || '—')}</td>
      <td class="num">${qty(x.received_cases)}</td>
      <td class="num">${x.current_cases == null ? '—' : qty(x.current_cases)}</td>
      <td><span class="sc-badge ${x.qc_result === 'Released' ? 'confirmed' : 'closed'}">${esc(x.qc_result)}</span>${x.hold_status === 'on_hold' ? ' <span class="sc-badge closed">HOLD</span>' : ''}</td>
      <td class="mono" style="font-size:11px">${esc(x.grn_number || '')}</td></tr>`).join('')}</tbody></table>` : none)}`,
  [{ label: 'Close', cls: 'ghost' }]);
}

function renderActions() {
  const h = ED.header, box = qs('[data-el="actions"]', ROOT);
  const isNew = ED.id == null;
  let btns = '';
  if (!ED.readonly) {
    btns += '<button class="sc-btn primary" data-act="save">💾 Save Draft</button>';
    btns += '<button class="sc-btn green" data-act="approve">✅ Approve PI</button>';
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
  drill: (d) => { const r = DASH_ROWS[+d.id]; if (r) openLineDrill(r); },
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
