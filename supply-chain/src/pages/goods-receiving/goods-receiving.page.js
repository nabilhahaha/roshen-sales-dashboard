// Goods Receiving — list of receipts and the batch-level QC screen. Warehouse
// staff receive each batch individually (Released / Rejected); inventory only
// increases for released batches, via the goods-receiving service. Below-minimum
// shelf-life batches prompt an audited Accept-Exception / Reject decision.
import { mount, delegate, wire, qsa } from '../../utils/dom.js';
import { esc, qty, today } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { statusBadge, shelfChip } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import {
  listGoodsReceipts, getGoodsReceipt, setBatchQc, releaseGoodsReceipt, recordShelfLifeException,
} from '../../services/goods-receiving/goods-receiving.service.js';
import { priceIndex } from '../../services/fulfillment/fulfillment.service.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';

export async function render(root, ctx) {
  const view = (ctx.params && ctx.params.view) || 'list';
  if (view === 'detail' && ctx.params.grId) return renderDetail(root, ctx, ctx.params.grId);
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  mount(root, loading('Loading goods receipts…'));
  let grs;
  try { grs = await listGoodsReceipts(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
  const rows = grs.map((g) => `<tr class="sc-row-link" data-act="open" data-id="${g.id}">
    <td class="mono"><b>${esc(g.grn_number || g.id)}</b></td>
    <td class="mono">${esc((g.delivery_note && g.delivery_note.dn_number) || '')}</td>
    <td class="mono">${esc((g.order && g.order.order_number) || '')}</td>
    <td>${esc(g.warehouse || '')}</td>
    <td>${esc(g.receipt_date || '')}</td>
    <td>${statusBadge(g.status)}</td></tr>`).join('')
    || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:22px">No goods receipts yet. Create one from a matched delivery note.</td></tr>';
  mount(root, `
    <div class="sc-card-h"><h3>🏬 Warehouse Receiving</h3><span class="sc-badge none" style="margin-left:8px">${grs.length}</span>
      <div class="sc-spacer"></div><button class="sc-btn sm ghost" data-act="dn">Delivery Notes →</button></div>
    <div class="sc-card"><p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Check and receive each batch. Only released batches enter the warehouse.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>GRN #</th><th>DN</th><th>PO</th><th>Warehouse</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`)}</div>`);
  delegate(root, {
    dn: () => ctx.navigate('delivery-notes'),
    open: ({ id }) => ctx.navigate('goods-receiving', { view: 'detail', grId: id }),
  });
}

async function renderDetail(root, ctx, grId) {
  mount(root, loading('Loading goods receipt…'));
  let gr, skus, prices;
  try {
    gr = await getGoodsReceipt(grId);
    skus = await listSkus();
    prices = await priceIndex(gr.order_id).catch(() => ({}));
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
  const byRoshen = indexByRoshen(skus), byCode = indexByCode(skus);
  const skuFor = (b) => byRoshen[String(b.roshen_id || '').trim()] || byCode[String(b.item_code || '').trim()] || null;
  const done = gr.status === 'Released' || gr.status === 'Partially Released' || gr.status === 'Rejected';

  const rows = gr.batches.map((b) => {
    const sku = skuFor(b);
    const sl = shelfLife(sku, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
    const sel = (v) => (b.qc_result === v ? 'selected' : '');
    const ctrl = done
      ? statusBadge(b.qc_result)
      : `<select class="sc-select sm" data-qc="${b.id}"><option value="Pending QC" ${sel('Pending QC')}>Pending QC</option><option value="Released" ${sel('Released')}>Release</option><option value="Rejected" ${sel('Rejected')}>Reject</option></select>`;
    const recv = done ? qty(b.received_cases)
      : `<input class="sc-input sm num" data-recv="${b.id}" type="number" min="0" step="1" value="${esc(String(b.received_cases ?? b.delivered_cases))}" style="max-width:90px">`;
    return `<tr${b.dn_batch_id ? '' : ''}>
      <td class="mono"><b>${esc(b.roshen_id || b.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(b.description || '')}</div></td>
      <td class="mono">${esc(b.batch_no || '—')}</td>
      <td>${esc(b.expiry_date || '—')}</td>
      <td>${shelfChip(sl)}${sl.belowMinimum ? '<div style="font-size:10.5px;color:#E03131;margin-top:2px">Shelf life below minimum</div>' : ''}</td>
      <td class="num">${qty(b.delivered_cases)}</td>
      <td class="num">${recv}</td>
      <td>${ctrl}</td></tr>`;
  }).join('');

  const anyBelow = gr.batches.some((b) => { const sl = shelfLife(skuFor(b), { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today()); return sl.belowMinimum; });

  mount(root, `
    <div class="sc-card-h"><h3>🏬 ${esc(gr.grn_number || 'Warehouse Receipt')}</h3><div class="sc-spacer"></div>
      ${statusBadge(gr.status)}<button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Goods Receiving</button></div>
    <div class="sc-card"><div class="sc-form-grid">
      <div class="sc-field"><label>PO</label><input class="sc-input" readonly value="${esc((gr.order && gr.order.order_number) || '')}"></div>
      <div class="sc-field"><label>Delivery Note</label><input class="sc-input" readonly value="${esc((gr.delivery_note && gr.delivery_note.dn_number) || '')}"></div>
      <div class="sc-field"><label>Warehouse</label><input class="sc-input" readonly value="${esc(gr.warehouse || '—')}"></div>
    </div></div>
    ${anyBelow && !done ? '<div class="sc-card" style="border-left:3px solid #F76707"><b>⚠ Shelf-life exceptions</b><p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0">One or more batches are below the SKU minimum remaining shelf life. Releasing such a batch records an <b>Accept Exception</b>; rejecting it records a <b>Reject Item</b>. Both are written to the audit log.</p></div>' : ''}
    <div class="sc-card"><div class="sc-card-h"><h3>📦 Batches — receive individually</h3></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th>Remaining shelf life</th><th class="num">Delivered</th><th class="num">Received</th><th>QC decision</th></tr></thead><tbody>${rows}</tbody></table></div>
    </div>
    ${done ? `<div class="sc-card"><span class="sc-badge confirmed">Receipt ${esc(gr.status)}</span> — released batches have been posted to inventory.</div>`
      : `<div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="sc-btn green" data-act="release">✅ Confirm &amp; Receive into Warehouse</button>
        <span style="font-size:12px;color:var(--text-secondary)">Released batches post to inventory as movements; rejected batches do not. This updates the PO received balance.</span></div>`}`);

  wire(root, { back: () => ctx.navigate('goods-receiving') });
  if (!done) {
    delegate(root, { release: () => releaseFlow() });
  }

  async function releaseFlow() {
    // read edits
    const edits = {};
    qsa('[data-qc]', root).forEach((s) => { edits[s.dataset.qc] = edits[s.dataset.qc] || {}; edits[s.dataset.qc].qc_result = s.value; });
    qsa('[data-recv]', root).forEach((i) => { edits[i.dataset.recv] = edits[i.dataset.recv] || {}; edits[i.dataset.recv].received = Number(i.value || 0); });

    if (!Object.values(edits).some((e) => e.qc_result === 'Released')) {
      if (!confirm('No batch is marked Released — nothing will be added to inventory. Continue?')) return;
    }
    try {
      for (const b of gr.batches) {
        const e = edits[b.id] || {};
        const decision = e.qc_result || b.qc_result || 'Pending QC';
        const received = decision === 'Released' ? (e.received != null ? e.received : b.delivered_cases) : 0;
        const rejected = decision === 'Rejected' ? b.delivered_cases : 0;
        await setBatchQc(b.id, { qc_result: decision, received_cases: received, rejected_cases: rejected });

        // audit below-minimum decisions
        const sl = shelfLife(skuFor(b), { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
        if (sl.belowMinimum && (decision === 'Released' || decision === 'Rejected')) {
          await recordShelfLifeException({
            order_id: gr.order_id, dn_id: gr.delivery_note_id, dn_batch_id: b.dn_batch_id,
            item_code: b.item_code, roshen_id: b.roshen_id, batch_no: b.batch_no, expiry_date: b.expiry_date,
            required_pct: sl.minPct, remaining_pct: sl.remainingPct,
            decision: decision === 'Released' ? 'Accept Exception' : 'Reject Item',
            reason: 'Warehouse QC decision', decided_by: 'goods-receiving',
          });
        }
      }
      const res = await releaseGoodsReceipt(gr.id, { warehouse: gr.warehouse, costByKey: prices, releasedBy: 'goods-receiving' });
      toast(`Receipt ${res.status} — ${res.released} released, ${res.rejected} rejected`, 'ok');
      ctx.navigate('goods-receiving', { view: 'detail', grId: gr.id });
    } catch (e) { toast('Release failed: ' + (e.message || e), 'err'); }
  }
}
