// Import preview — shows the validated lines, the import stats, and any
// unknown / invalid rows. Presentational; wires the supplied handlers.
import { mount, wire } from '../../../utils/dom.js';
import { esc, money, qty as fmtQty } from '../../../utils/format.js';
import { tableWrap } from '../../../components/table/table.js';

export function renderPreview(root, { result, filename, handlers }) {
  const s = result.stats;
  const tile = (lbl, val, cls) => `<div class="sc-sum-card ${cls || ''}"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;

  const lineRows = result.lines.map((l, i) => `
    <tr><td>${i + 1}</td><td class="mono"><b>${esc(l.item_code)}</b></td><td class="mono">${esc(l.roshen_id || '—')}</td>
      <td>${esc(l.item_description || '')}</td><td class="num">${fmtQty(l.ordered_cases)}</td>
      <td class="num">${money(l.price_case)}</td><td class="num"><b>${money(l.ordered_cases * l.price_case)}</b></td></tr>`).join('')
    || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">No valid lines to import</td></tr>';

  const issues = [];
  if (result.unknown.length) {
    issues.push(`<div class="sc-card"><div class="sc-card-h"><h3>⚠ Unknown items (${result.unknown.length})</h3>
      <div class="sc-spacer"></div><span style="font-size:12px;color:var(--text-muted)">Not found in SKU Master — skipped</span></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Item Code</th><th>Roshen ID</th><th class="num">Qty</th><th>Reason</th></tr></thead><tbody>${result.unknown.map((u) => `<tr><td class="mono">${esc(u.code)}</td><td class="mono">${esc(u.roshen)}</td><td class="num">${esc(u.qty)}</td><td>${esc(u.reason)}</td></tr>`).join('')}</tbody></table>`)}</div>`);
  }
  if (result.invalid.length) {
    issues.push(`<div class="sc-card"><div class="sc-card-h"><h3>⚠ Invalid quantity (${result.invalid.length})</h3>
      <div class="sc-spacer"></div><span style="font-size:12px;color:var(--text-muted)">Skipped</span></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Item Code</th><th class="num">Qty</th><th>Reason</th></tr></thead><tbody>${result.invalid.map((u) => `<tr><td class="mono">${esc(u.code)}</td><td class="num">${esc(u.qty)}</td><td>${esc(u.reason)}</td></tr>`).join('')}</tbody></table>`)}</div>`);
  }

  mount(root, `
    <div class="sc-card-h"><h3>🔎 Import Preview</h3><div class="sc-spacer"></div>
      <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(filename || '')}</span>
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Back to Mapping</button></div>

    <div class="sc-card"><div class="sc-summary">
      ${tile('Imported Rows', s.importedRows)}
      ${tile('Matched Items', s.matched)}
      ${tile('Unknown Items', s.unknown, s.unknown ? 'warn' : '')}
      ${tile('Duplicates Merged', s.duplicatesMerged)}
      ${tile('Grand Total (SAR)', money(s.grandTotal), 'grand')}
    </div></div>

    <div class="sc-card"><div class="sc-card-h"><h3>📦 Order lines (${result.lines.length})</h3></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>#</th><th>Item Code</th><th>Roshen ID</th><th>Description</th><th class="num">Quantity</th><th class="num">Case Price</th><th class="num">Line Total</th></tr></thead><tbody>${lineRows}</tbody></table>`)}</div>

    ${issues.join('')}

    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="sc-btn primary" data-act="confirm" ${result.lines.length ? '' : 'disabled'}>✅ Confirm &amp; Create Draft Order</button>
      <span style="font-size:12px;color:var(--text-secondary)">Creates a normal Draft purchase order you can then edit, add items to, and approve.</span>
      <button class="sc-btn ghost" style="margin-left:auto" data-act="cancel">Cancel</button>
    </div>`);
  wire(root, handlers);
}
