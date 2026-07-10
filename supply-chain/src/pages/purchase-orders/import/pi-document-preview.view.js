// PI document preview — shown when the uploaded Excel is recognized as a
// supplier Purchase Invoice document. Mirrors the document 1:1 (header block,
// all line columns, totals) so the user confirms what the file actually says
// before it becomes the PI master record. Presentational; wires the handlers.
import { mount, wire } from '../../../utils/dom.js';
import { esc, money, qty as fmtQty } from '../../../utils/format.js';
import { tableWrap } from '../../../components/table/table.js';

const val = (v) => (v == null || v === '' ? '—' : esc(String(v)));
const kv = (label, v) => `<div style="min-width:150px"><span class="erp-mini">${label}</span><br><b style="font-size:12.5px">${val(v)}</b></div>`;

export function renderDocumentPreview(root, { plan, filename, handlers }) {
  const h = plan.header;
  const hasDiscount = plan.lines.concat(plan.unknown).some((l) => Number(l.discount_percent) > 0);
  const cur = h.currency || 'SAR';

  const matchChip = (m) => m === 'none'
    ? '<span class="sc-badge closed">Not in SKU Master</span>'
    : `<span class="sc-badge confirmed">SKU ✓</span>`;

  const lineRow = (l, excluded) => `<tr${excluded ? ' style="opacity:.55"' : ''}>
      <td>${val(l.line_no)}</td>
      <td class="mono"><b>${val(l.supplier_item_code || l.item_code)}</b>${l.supplier_item_code && l.item_code && l.supplier_item_code !== l.item_code ? `<div style="font-size:10px;color:var(--text-muted)">${esc(l.item_code)}</div>` : ''}</td>
      <td class="mono">${val(l.roshen_id)}</td>
      <td style="font-size:12px;min-width:220px">${val(l.item_description)}</td>
      <td>${val(l.uom)}</td>
      <td class="num">${l.units_qty == null ? '—' : fmtQty(l.units_qty)}</td>
      <td class="num"><b>${l.ordered_cases == null ? '—' : fmtQty(l.ordered_cases)}</b></td>
      <td class="num">${l.unit_price == null ? '—' : money(l.unit_price)}</td>
      ${hasDiscount ? `<td class="num">${l.discount_percent == null ? '—' : esc(String(l.discount_percent)) + '%'}</td>
      <td class="num">${l.net_unit_price == null ? '—' : money(l.net_unit_price)}</td>` : ''}
      <td class="num">${l.taxable_amount == null ? '—' : money(l.taxable_amount)}</td>
      <td class="num">${val(l.vat_percent)}</td>
      <td class="num">${l.vat_amount == null ? '—' : money(l.vat_amount)}</td>
      <td class="num"><b>${l.amount == null ? '—' : money(l.amount)}</b></td>
      <td>${excluded ? '<span class="sc-badge closed">Excluded</span> ' : ''}${matchChip(l._match)}</td>
    </tr>`;

  const headCols = `<th>No.</th><th>Item Code</th><th>Roshen Code</th><th>Item Description</th><th>Unit</th>
    <th class="num">Units</th><th class="num">Ordered Qty<br><span style="font-weight:400">(Box/Pcs)</span></th><th class="num">Price (${esc(cur)})</th>
    ${hasDiscount ? `<th class="num">Discount %</th><th class="num">Price after Discount</th>` : ''}
    <th class="num">Taxable (${esc(cur)})</th><th class="num">VAT %</th><th class="num">VAT (${esc(cur)})</th><th class="num">Amount (${esc(cur)})</th><th>SKU Match</th>`;

  const checkLine = (label, c) => c.document == null ? '' :
    `<span style="font-size:11.5px;color:${c.ok ? '#2FB344' : '#E03131'}">${c.ok ? '✓' : '✗'} ${label}: document ${money(c.document)}${c.ok ? '' : ' vs lines ' + money(c.computed)}</span>`;

  const warn = [];
  if (plan.unknown.length) warn.push(`<div class="sc-locked-banner" style="background:rgba(230,81,12,.1);border-color:rgba(247,103,7,.35);color:var(--text-primary)">⚠ <b>&nbsp;${plan.unknown.length} item(s) not found in the SKU Master</b>&nbsp;— they are shown below but will not be imported. Add them to the SKU Master first, then re-import.</div>`);
  if (plan.badQty.length) warn.push(`<div class="sc-locked-banner">⛔ ${plan.badQty.length} line(s) skipped — quantity missing or zero.</div>`);
  if (!h.order_number) warn.push('<div class="sc-locked-banner">⚠ No document number found — a PI number will be auto-generated.</div>');

  mount(root, `
    <div class="sc-card-h"><h3>🧾 ${esc(h.document_type || 'Purchase Invoice')} ${esc(h.order_number || '')}</h3>
      <div class="sc-spacer"></div>
      <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(filename || '')}</span></div>
    <div class="sc-locked-banner" style="background:rgba(25,113,194,.08);border-color:rgba(25,113,194,.3);color:var(--text-primary)">
      📄 This file was recognized as a supplier Purchase Invoice. Review it exactly as the document reads — nothing has been created yet.</div>
    ${warn.join('')}

    <div class="sc-card">
      <div class="sc-card-h"><h3>Supplier</h3></div>
      <div style="display:flex;gap:22px;flex-wrap:wrap">
        ${kv('Company', h.supplier)}${kv('VAT No.', h.supplier_vat)}${kv('CR Number', h.supplier_cr)}
        ${kv('Short Address', h.supplier_short_address)}${kv('Bank', h.supplier_bank)}${kv('IBAN', h.supplier_iban)}</div>
      ${h.supplier_address ? `<div style="margin-top:8px;font-size:12px;color:var(--text-secondary)">${esc(h.supplier_address)}</div>` : ''}
    </div>

    <div class="sc-card"><div style="display:flex;gap:22px;flex-wrap:wrap">
      ${kv('Customer', h.customer_name)}${kv('Customer VAT №', h.customer_vat)}${kv('Customer CR', h.customer_cr)}
      ${kv('Document Date', h.order_date)}${kv('Currency', h.currency)}${kv('Salesman', h.salesman)}</div></div>

    <div class="sc-card">
      <div class="sc-card-h"><h3>📦 Items (${plan.lines.length}${plan.unknown.length ? ' + ' + plan.unknown.length + ' excluded' : ''})</h3></div>
      ${tableWrap(`<table class="sc-table"><thead><tr>${headCols}</tr></thead><tbody>
        ${plan.lines.map((l) => lineRow(l, false)).join('')}
        ${plan.unknown.map((l) => lineRow(l, true)).join('')}
        ${plan.badQty.map((l) => lineRow(l, true)).join('')}
      </tbody></table>`)}
    </div>

    <div class="sc-card"><div class="sc-summary">
      <div class="sc-sum-card"><div class="lbl">Items</div><div class="val">${plan.lines.length}</div></div>
      <div class="sc-sum-card"><div class="lbl">Total Units</div><div class="val">${h.total_units == null ? '—' : fmtQty(h.total_units)}</div></div>
      <div class="sc-sum-card"><div class="lbl">Total Net (${esc(cur)})</div><div class="val">${h.total_net == null ? '—' : money(h.total_net)}</div></div>
      <div class="sc-sum-card"><div class="lbl">Total VAT (${esc(cur)})</div><div class="val">${h.total_vat == null ? '—' : money(h.total_vat)}</div></div>
      <div class="sc-sum-card grand"><div class="lbl">Grand Total (${esc(cur)})</div><div class="val">${h.total_gross == null ? '—' : money(h.total_gross)}</div></div>
      <div class="sc-sum-card"><div class="lbl">Gross Weight (kg)</div><div class="val">${h.gross_weight_kg == null ? '—' : fmtQty(h.gross_weight_kg)}</div></div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px">
      ${checkLine('Net total', plan.checks.net)}${checkLine('VAT total', plan.checks.vat)}${checkLine('Grand total', plan.checks.gross)}
    </div></div>

    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="sc-btn primary" data-act="confirm" ${plan.lines.length ? '' : 'disabled'}>✅ Create Purchase Invoice (PI)</button>
      <span style="font-size:12px;color:var(--text-secondary)">Creates a Draft PI holding the document exactly as shown — review and approve it next.</span>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="sc-btn ghost" data-act="manual">Match Columns Manually</button>
        <button class="sc-btn ghost" data-act="cancel">Cancel</button></div>
    </div>`);

  wire(root, {
    confirm: () => handlers.confirm(plan),
    manual: () => handlers.manual(),
    cancel: () => handlers.cancel(),
  });
}
