// Validation report view — the side-by-side PI ↔ Order comparison.
// Presentational: given a parsed PI + compare result + order context, renders
// the report and wires the supplied action handlers. No Supabase access here.
import { mount, wire } from '../../utils/dom.js';
import { esc, money, qty } from '../../utils/format.js';
import { piBadge, tableWrap } from '../../components/table/table.js';
import { readonlyField } from '../../components/forms/forms.js';

const diffCell = (bad) => (bad ? 'style="background:rgba(224,49,49,.12);color:#ff6b6b;font-weight:700"' : '');

// opts: { parsed, compare, order, saved (pi|null), skuByRoshen, disputes, handlers }
export function renderReport(root, opts) {
  const { parsed: p, compare: cmp, order, saved, skuByRoshen = {}, disputes: openDisputes = [], handlers = {} } = opts;
  const s = cmp.summary, cur = p.header.currency || 'SAR';

  const tile = (lbl, val, cls) => `<div class="sc-sum-card ${cls || ''}"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;

  const head = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Imported PI — Header</h3><div class="sc-spacer"></div>
      <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(p.source_filename || '')}</span></div>
    <div class="sc-form-grid">
      ${readonlyField('PI Number', p.header.pi_number)}${readonlyField('PI Date', p.header.pi_date)}${readonlyField('Supplier', p.header.supplier)}
      ${readonlyField('Customer', p.header.customer)}${readonlyField('Currency', cur)}${readonlyField('VAT Number', p.header.vat_number)}
      ${readonlyField('CR Number', p.header.cr_number)}${readonlyField('Payment Terms', p.header.payment_terms)}${readonlyField('Delivery Terms', p.header.delivery_terms)}
    </div></div>`;

  const summary = `<div class="sc-card"><div class="sc-card-h"><h3>📊 Validation Summary</h3><div class="sc-spacer"></div>
      ${s.ok ? '<span class="sc-badge confirmed">✓ Fully Matched</span>' : '<span class="sc-badge closed">⚠ Validation Required</span>'}</div>
    <div class="sc-summary">
      ${tile('Matching Items', s.matched)}${tile('Different Items', s.different)}${tile('Missing in PI', s.missing)}
      ${tile('Extra in PI', s.additional)}${tile('Qty Δ (cases)', qty(s.qtyDiff), s.qtyDiff ? 'grand' : '')}${tile('Net Value Δ (' + cur + ')', money(s.valueDiff), s.valueDiff ? 'grand' : '')}
    </div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-top:14px;font-size:12.5px">
      <div>Order net total: <b>${money(s.orderNet)} SAR</b></div>
      <div>PI net (taxable) total: <b>${money(s.piNet)} ${cur}</b></div>
      <div>PI grand total (incl VAT): <b>${money(p.totals.grand_total)} ${cur}</b></div>
    </div></div>`;

  const rows = cmp.rows.map((r) => {
    const badge = `<span class="sc-badge ${r.kind === 'matched' ? 'confirmed' : r.kind === 'additional' ? 'pi' : 'closed'}">${lineLabel(r.kind)}</span>`;
    const o = r.order, pi = r.pi;
    const code = (o && o.item_code) || (pi && (skuByRoshen[pi.roshen_id] ? skuByRoshen[pi.roshen_id].item_code : pi.pi_item_code)) || '—';
    const rosh = (o && o.roshen_id) || (pi && pi.roshen_id) || '—';
    const desc = (o && o.description) || (pi && pi.description) || '';
    return `<tr>
      <td class="mono">${esc(code)}<br><span style="font-size:10.5px;color:var(--text-muted)">R ${esc(rosh)}</span></td>
      <td style="max-width:260px">${esc(desc)}</td>
      <td class="num" ${r.qtyOk === false ? diffCell(true) : ''}>${o ? qty(o.cases) : '—'} → ${pi ? qty(pi.box_pcs) : '—'}</td>
      <td class="num" ${r.priceOk === false ? diffCell(true) : ''}>${o ? money(o.case_price) : '—'} → ${pi ? money(pi.case_price) : '—'}</td>
      <td class="num" ${r.amtOk === false ? diffCell(true) : ''}>${o ? money(o.line_total) : '—'} → ${pi ? money(pi.taxable_amount) : '—'}</td>
      <td class="num">${pi ? qty(pi.vat_percent) + '% / ' + money(pi.vat_amount) : '—'}</td>
      <td>${badge}</td></tr>`;
  }).join('');

  const cmpCard = `<div class="sc-card"><div class="sc-card-h"><h3>🔍 Line-by-line Comparison</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">Matched by Item Code → Roshen ID · values shown as Order → PI</span></div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th>Description</th><th class="num">Qty (cases)</th><th class="num">Price/Case</th><th class="num">Net Amount</th><th class="num">PI VAT</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`)}</div>`;

  const printExcel = '<div style="margin-left:auto;display:flex;gap:8px"><button class="sc-btn ghost" data-act="print">🖨 Print</button><button class="sc-btn ghost" data-act="excel">⬇ Excel</button></div>';
  let actions = '<div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">';
  if (!saved) {
    actions += `<button class="sc-btn primary" data-act="save">💾 Save &amp; Link PI</button>
      <span style="font-size:12px;color:var(--text-secondary)">Saving links this PI to ${esc(order.order_number)}. Differences will open a Purchase Order revision — the PI is never rejected.</span>`;
  } else if (saved.status === 'Approved') {
    // PI already approved — offer the final Ready-for-Shipment step
    if (order && order.status === 'Ready for Shipment') actions += '<span class="sc-badge confirmed">🚚 Ready for Shipment</span>';
    else actions += '<button class="sc-btn green" data-act="ship">🚚 Mark Ready for Shipment</button>';
    actions += printExcel;
  } else if (s.ok) {
    // PO (latest revision) matches the PI → approve
    actions += '<button class="sc-btn green" data-act="approve">✅ Approve PI</button>';
    actions += '<span style="font-size:12px;color:var(--text-secondary)">The purchase order matches the PI.</span>';
    actions += printExcel;
  } else {
    // differences → the user chooses: create a revision, OR keep the PO as the
    // contractual baseline and dispute the differences (the PI is never rejected).
    const nDiff = s.different + s.missing + s.additional;
    actions += '<button class="sc-btn primary" data-act="revise">🛠 Create Purchase Order Revision</button>';
    if (!openDisputes.length) actions += '<button class="sc-btn ghost" data-act="dispute">⚖ Keep PO — Dispute Differences</button>';
    actions += `<span style="font-size:12px;color:var(--text-secondary)">${nDiff} difference(s). Accept them into a revision, or keep the PO baseline and record them as disputes. The PI is never rejected.</span>`;
    actions += printExcel;
  }
  actions += '</div>';

  // Open-disputes panel: operations proceed on the PO baseline; disputed PI
  // lines never enter delivery / receiving / inventory until resolved.
  let disputeCard = '';
  if (openDisputes.length) {
    const drows = openDisputes.map((d) => `<tr>
      <td><span class="sc-badge closed">${esc(lineLabel(d.kind))}</span></td>
      <td class="mono">${esc(d.item_code || '')}<br><span style="font-size:10.5px;color:var(--text-muted)">R ${esc(d.roshen_id || '—')}</span></td>
      <td>${esc(d.description || '')}</td>
      <td class="num">${d.po_qty == null ? '—' : qty(d.po_qty)} → ${d.pi_qty == null ? '—' : qty(d.pi_qty)}</td>
      <td class="num">${d.po_price == null ? '—' : money(d.po_price)} → ${d.pi_price == null ? '—' : money(d.pi_price)}</td>
      <td class="num">${money(d.value_delta)}</td>
      <td><button class="sc-btn sm ghost" data-act="close-dispute" data-id="${d.id}">Close</button></td></tr>`).join('');
    disputeCard = `<div class="sc-card" style="border-left:3px solid #F76707">
      <div class="sc-card-h"><h3>⚖ Open Disputes (${openDisputes.length})</h3><div class="sc-spacer"></div>
        <span class="sc-badge closed">Operating on PO baseline</span></div>
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px">The purchase order is unchanged and drives all operations. These PI differences are recorded as disputes and are excluded from delivery, receiving, inventory and matching until you create a revision or close them.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Type</th><th>Item</th><th>Description</th><th class="num">Qty (PO→PI)</th><th class="num">Price (PO→PI)</th><th class="num">Value Δ</th><th></th></tr></thead><tbody>${drows}</tbody></table>`)}</div>`;
  }

  const back = `<div class="sc-card-h"><h3>🧾 ${saved ? 'Proforma Invoice ' + esc(saved.pi_number || '') : 'Import Proforma Invoice'}</h3>
      <div class="sc-spacer"></div>${saved ? piBadge(saved.status) : ''}
      ${openDisputes.length ? `<span class="sc-badge closed" style="margin-left:6px">${openDisputes.length} open dispute(s)</span>` : ''}
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Back</button></div>`;

  mount(root, back + head + summary + cmpCard + disputeCard + actions);
  wire(root, handlers);
}

function lineLabel(kind) {
  return ({ matched: '✓ Match', qty_diff: '✗ Quantity', price_diff: '✗ Price', amount_diff: '✗ Amount', missing: '✗ Missing in PI', additional: '✗ Extra in PI' })[kind] || kind;
}
