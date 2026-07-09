// Import preview — editable order lines, import summary, duplicate-merge
// breakdown, and the failed-rows report. Presentational; wires the handlers.
// The order-lines table is bounded by the SKU count, so editing stays fast
// even for large imports; failed-row tables are capped for display.
import { mount, wire, qs, qsa } from '../../../utils/dom.js';
import { esc, money, qty as fmtQty } from '../../../utils/format.js';
import { tableWrap } from '../../../components/table/table.js';

const CAP = 100; // max failed rows shown (full list still exported)

export function renderPreview(root, { result, filename, handlers }) {
  // editable working copy of the merged lines
  const lines = result.lines.map((l) => ({ ...l }));

  const failedTable = (rows, title, icon) => {
    if (!rows.length) return '';
    const shown = rows.slice(0, CAP);
    const more = rows.length - shown.length;
    return `<div class="sc-card"><div class="sc-card-h"><h3>${icon} ${title} (${rows.length})</h3>
      <div class="sc-spacer"></div><button class="sc-btn sm ghost" data-act="errors">⬇ Download Error Report</button></div>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Excel Row</th><th>Item Code</th><th>Roshen ID</th><th class="num">Qty</th><th>Reason</th></tr></thead><tbody>${
        shown.map((u) => `<tr><td>${esc(u.rowNo)}</td><td class="mono">${esc(u.code)}</td><td class="mono">${esc(u.roshen)}</td><td class="num">${esc(u.qty)}</td><td>${esc(u.reason)}</td></tr>`).join('')
      }</tbody></table>`)}
      ${more > 0 ? `<div style="padding:8px 2px 0;font-size:12px;color:var(--text-muted)">…and ${more} more — use Download Error Report for the full list.</div>` : ''}</div>`;
  };

  const draw = () => {
    const lineRows = lines.map((l, i) => {
      const mergeNote = l.merges && l.merges.length > 1
        ? `<div style="font-size:10.5px;color:var(--text-muted)">merged: ${l.merges.map((q) => fmtQty(q)).join(' + ')} → ${fmtQty(l.merges.reduce((a, b) => a + b, 0))}</div>` : '';
      return `<tr>
        <td>${i + 1}</td>
        <td class="mono"><b>${esc(l.item_code)}</b>${l.merges && l.merges.length > 1 ? ' <span class="sc-badge pi" style="font-size:9px">merged ×' + l.merges.length + '</span>' : ''}</td>
        <td class="mono">${esc(l.roshen_id || '—')}</td>
        <td>${esc(l.item_description || '')}${mergeNote}</td>
        <td class="num"><input class="sc-input sc-qty-input" data-qi="${i}" type="number" min="0" step="1" value="${esc(l.ordered_cases)}"></td>
        <td class="num">${money(l.price_case)}</td>
        <td class="num" data-lt="${i}"><b>${money(l.ordered_cases * l.price_case)}</b></td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);padding:20px">No valid lines to import</td></tr>';

    mount(root, `
      <div class="sc-card-h"><h3>🔎 Import Preview</h3><div class="sc-spacer"></div>
        <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(filename || '')}</span>
        <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Back to Mapping</button></div>

      <div class="sc-card"><div class="sc-summary" data-el="summary"></div></div>

      <div class="sc-card"><div class="sc-card-h"><h3>📦 Order lines (${lines.length})</h3><div class="sc-spacer"></div>
        <span style="font-size:12px;color:var(--text-muted)">Quantities are editable — fix here without re-importing.</span></div>
        ${tableWrap(`<table class="sc-table"><thead><tr><th>#</th><th>Item Code</th><th>Roshen ID</th><th>Description</th><th class="num">Quantity</th><th class="num">Case Price</th><th class="num">Line Total</th></tr></thead><tbody>${lineRows}</tbody></table>`)}</div>

      ${failedTable(result.unknown, 'Unknown items', '⚠')}
      ${failedTable(result.errors, 'Rows with errors', '⛔')}

      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="sc-btn primary" data-act="confirm" ${lines.length ? '' : 'disabled'}>✅ Confirm &amp; Create Draft Order</button>
        <span style="font-size:12px;color:var(--text-secondary)">Creates a normal Draft you can further edit and approve.</span>
        <button class="sc-btn ghost" style="margin-left:auto" data-act="cancel">Cancel</button>
      </div>`);

    updateSummary();
    qsa('[data-qi]', root).forEach((inp) => inp.addEventListener('input', () => onQty(+inp.dataset.qi, inp)));
    wire(root, {
      back: handlers.back,
      cancel: handlers.cancel,
      errors: () => handlers.downloadErrors(),
      confirm: () => handlers.confirm(lines.filter((l) => Number(l.ordered_cases) > 0)),
    });
  };

  function onQty(i, inp) {
    let v = parseFloat(inp.value); if (isNaN(v)) v = 0;
    lines[i].ordered_cases = v;
    const cell = qs(`[data-lt="${i}"]`, root); if (cell) cell.innerHTML = `<b>${money(v * lines[i].price_case)}</b>`;
    updateSummary();
  }

  function updateSummary() {
    const s = result.stats;
    const grand = lines.reduce((a, l) => a + (Number(l.ordered_cases) || 0) * l.price_case, 0);
    const tile = (lbl, val, cls) => `<div class="sc-sum-card ${cls || ''}"><div class="lbl">${lbl}</div><div class="val">${val}</div></div>`;
    const box = qs('[data-el="summary"]', root); if (!box) return;
    box.innerHTML =
      tile('Imported Rows', s.importedRows) +
      tile('Matched Items', s.matched) +
      tile('Duplicates Merged', s.duplicatesMerged) +
      tile('Unknown Items', s.unknown, s.unknown ? 'warn' : '') +
      tile('Rows With Errors', s.errors, s.errors ? 'warn' : '') +
      tile('Grand Total (SAR)', money(grand), 'grand');
  }

  draw();
}
