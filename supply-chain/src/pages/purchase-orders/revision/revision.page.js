// Purchase Order Revision screen — resolve PI-vs-PO differences and apply a new
// revision (never rejects the PI, never overwrites the original PO).
import { mount, wire, qs, qsa } from '../../../utils/dom.js';
import { esc, money, qty as fmtQty } from '../../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../../components/table/table.js';
import { toast } from '../../../components/notifications/toast.js';
import { listSkus, indexByRoshen } from '../../../services/sku/sku.service.js';
import { getOrder } from '../../../services/purchase-orders/orders.service.js';
import { getPiWithItems } from '../../../services/pi/pi.service.js';
import { getEffectiveLines, computeRevision, applyRevision, additionalKey } from '../../../services/purchase-orders/revision.service.js';
import { comparePiToOrder } from '../../../services/pi/pi-compare.js';
import { toParsed } from '../../validation/validation.page.js';

const CURRENT_USER = 'Development';

export async function render(root, ctx) {
  const { orderId, piId } = ctx.params || {};
  if (!orderId || !piId) { mount(root, emptyState('⚠', 'Missing order or PI reference.')); return; }
  mount(root, loading('Loading differences…'));

  let order, pi, skuByRoshen, compare, effective;
  try {
    [order, pi] = await Promise.all([getOrder(orderId), getPiWithItems(piId)]);
    skuByRoshen = indexByRoshen(await listSkus());
    effective = await getEffectiveLines(order);
    compare = comparePiToOrder(effective, toParsed(pi));
  } catch (e) { mount(root, emptyState('⚠', e.message || String(e))); return; }

  const removed = compare.rows.filter((r) => r.kind === 'missing');
  const qtyRows = compare.rows.filter((r) => r.kind === 'qty_diff');
  const priceRows = compare.rows.filter((r) => r.kind === 'price_diff');
  const added = compare.rows.filter((r) => r.kind === 'additional');
  const nextRev = (order.current_revision || 0) + 1;

  if (!removed.length && !qtyRows.length && !priceRows.length && !added.length) {
    mount(root, `<div class="sc-card-h"><h3>🛠 Revision — ${esc(order.order_number)}</h3><div class="sc-spacer"></div>
      <button class="sc-btn sm ghost" data-act="back">← Back</button></div>
      ${emptyState('✓', 'The purchase order already matches the PI — no revision needed.')}`);
    wire(root, { back: () => ctx.navigate('validation', { piId }) });
    return;
  }

  const sel = (key, opts) => `<select class="sc-select" data-key="${esc(key)}" style="min-width:150px">${opts.map((o) => `<option value="${o.v}"${o.d ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
  const reason = (key) => `<input class="sc-input" data-reason="${esc(key)}" placeholder="Reason (optional)" style="min-width:180px">`;

  const removedCard = removed.length ? `<div class="sc-card"><div class="sc-card-h"><h3>🗑 Removed Items (${removed.length})</h3>
    <div class="sc-spacer"></div><span style="font-size:12px;color:var(--text-muted)">In PO but missing from PI</span></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th>Description</th><th class="num">PO Qty</th><th>Action</th><th>Reason</th></tr></thead><tbody>${
      removed.map((r) => `<tr><td class="mono"><b>${esc(r.order.item_code)}</b></td><td>${esc(r.order.description || '')}</td>
        <td class="num">${fmtQty(r.order.cases)}</td>
        <td>${sel(r.order.item_code, [{ v: 'remove', t: '✓ Remove from PO', d: true }, { v: 'keep', t: 'Keep in PO' }])}</td>
        <td>${reason(r.order.item_code)}</td></tr>`).join('')}</tbody></table>`)}</div>` : '';

  const qtyCard = qtyRows.length ? `<div class="sc-card"><div class="sc-card-h"><h3>🔢 Quantity Changes (${qtyRows.length})</h3></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th class="num">PO Qty</th><th class="num">PI Qty</th><th>Action</th><th>Reason</th></tr></thead><tbody>${
      qtyRows.map((r) => `<tr><td class="mono"><b>${esc(r.order.item_code)}</b><br><span style="font-size:11px;color:var(--text-muted)">${esc(r.order.description || '')}</span></td>
        <td class="num">${fmtQty(r.order.cases)}</td><td class="num"><b>${fmtQty(r.pi.box_pcs)}</b></td>
        <td>${sel(r.order.item_code, [{ v: 'accept', t: '✓ Accept PI Qty', d: true }, { v: 'keep', t: 'Keep Original' }])}</td>
        <td>${reason(r.order.item_code)}</td></tr>`).join('')}</tbody></table>`)}</div>` : '';

  const priceCard = priceRows.length ? `<div class="sc-card"><div class="sc-card-h"><h3>💲 Price Changes (${priceRows.length})</h3></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th class="num">PO Price</th><th class="num">PI Price</th><th class="num">Diff</th><th>Action</th><th>Reason</th></tr></thead><tbody>${
      priceRows.map((r) => { const d = r.pi.case_price - r.order.case_price; return `<tr><td class="mono"><b>${esc(r.order.item_code)}</b></td>
        <td class="num">${money(r.order.case_price)}</td><td class="num"><b>${money(r.pi.case_price)}</b></td>
        <td class="num" style="color:${d > 0 ? '#E03131' : '#2FB344'}">${d > 0 ? '+' : ''}${money(d)}</td>
        <td>${sel(r.order.item_code, [{ v: 'accept', t: '✓ Accept PI Price', d: true }, { v: 'keep', t: 'Keep Original' }])}</td>
        <td>${reason(r.order.item_code)}</td></tr>`; }).join('')}</tbody></table>`)}</div>` : '';

  const addedCard = added.length ? `<div class="sc-card"><div class="sc-card-h"><h3>➕ New Items (${added.length})</h3>
    <div class="sc-spacer"></div><span style="font-size:12px;color:var(--text-muted)">In PI but not in PO</span></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th class="num">PI Qty</th><th class="num">PI Price</th><th>Action</th><th>Reason</th></tr></thead><tbody>${
      added.map((r) => { const sku = skuByRoshen[r.pi.roshen_id]; const key = additionalKey(r.pi, skuByRoshen);
        const label = sku ? `${esc(sku.item_code)} <span style="font-size:11px;color:var(--text-muted)">${esc(sku.item_description || '')}</span>` : `<span style="color:var(--text-muted)">Roshen ${esc(r.pi.roshen_id || '—')} (not in SKU Master)</span>`;
        return `<tr><td class="mono">${label}</td><td class="num">${fmtQty(r.pi.box_pcs)}</td><td class="num">${money(r.pi.case_price)}</td>
        <td>${sku ? sel(key, [{ v: 'ignore', t: 'Ignore', d: true }, { v: 'add', t: '✓ Add to PO' }]) : '<span class="sc-badge none">cannot add</span>'}</td>
        <td>${sku ? reason(key) : ''}</td></tr>`; }).join('')}</tbody></table>`)}</div>` : '';

  mount(root, `
    <div class="sc-card-h"><h3>🛠 Purchase Order Revision — ${esc(order.order_number)}</h3>
      <div class="sc-spacer"></div><span class="sc-badge pi">Will create Revision ${nextRev}</span>
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Back</button></div>
    <div class="sc-card" style="font-size:12.5px;color:var(--text-secondary)">
      Roshen's PI differs from the purchase order. Resolve each difference below and click <b>Apply Revision</b> —
      this creates <b>Revision ${nextRev}</b> and keeps the original purchase order unchanged for audit.
    </div>
    ${removedCard}${qtyCard}${priceCard}${addedCard}
    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="sc-btn primary" data-act="apply">✅ Apply Revision ${nextRev}</button>
      <span style="font-size:12px;color:var(--text-secondary)">Creates Revision ${nextRev}; the original PO (Revision 0) is preserved.</span>
      <button class="sc-btn ghost" style="margin-left:auto" data-act="back">Cancel</button>
    </div>`);

  wire(root, {
    back: () => ctx.navigate('validation', { piId }),
    apply: async () => {
      const resolutions = {};
      qsa('[data-key]', root).forEach((s) => { resolutions[s.dataset.key] = { action: s.value }; });
      qsa('[data-reason]', root).forEach((i) => { const k = i.dataset.reason; if (resolutions[k]) resolutions[k].reason = i.value.trim() || null; });
      const { lines, changes } = computeRevision(compare.rows, resolutions, skuByRoshen, CURRENT_USER);
      if (!lines.length) { toast('The revision would have no items — keep at least one line', 'err'); return; }
      try {
        const { revisionNo } = await applyRevision(orderId, lines, changes, piId, CURRENT_USER);
        toast(`Revision ${revisionNo} applied`, 'ok');
        ctx.navigate('validation', { piId });
      } catch (e) { toast('Apply failed: ' + (e.message || e), 'err'); }
    },
  });
}
