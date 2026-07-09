// Mapping wizard — left: Excel columns, right: ERP field selectors. Lets the
// user map columns, apply/save a named mapping, and continue to preview.
// Presentational; reads the current <select> values on demand.
import { mount, wire, qsa } from '../../../utils/dom.js';
import { esc } from '../../../utils/format.js';
import { ERP_FIELDS } from '../../../services/import/order-mapping.service.js';

function optionList(selected) {
  const opts = ['<option value="ignore">— Ignore —</option>']
    .concat(ERP_FIELDS.map((f) => `<option value="${f.key}" ${selected === f.key ? 'selected' : ''}>${esc(f.label)}${f.required ? ' *' : ''}</option>`));
  return opts.join('');
}

export function renderWizard(root, { columns, mapByIdx, savedMappings, filename, handlers }) {
  const rows = columns.map((c) => `
    <tr>
      <td><b>${esc(c.label)}</b>${c.sample ? `<div style="font-size:11px;color:var(--text-muted)">e.g. ${esc(c.sample)}</div>` : ''}</td>
      <td style="text-align:center;color:var(--text-muted)">→</td>
      <td><select class="sc-select" data-col="${c.idx}">${optionList(mapByIdx[c.idx])}</select></td>
    </tr>`).join('');

  const savedOpts = savedMappings.length
    ? `<select class="sc-select" data-el="saved" style="max-width:220px"><option value="">Apply saved mapping…</option>${savedMappings.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')}</select>`
    : '';

  mount(root, `
    <div class="sc-card-h"><h3>🧭 Map Excel Columns → ERP Fields</h3><div class="sc-spacer"></div>
      <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(filename || '')}</span>
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="cancel">← Cancel</button></div>

    <div class="sc-card">
      <div class="sc-card-h" style="margin-bottom:10px">
        <span style="font-size:12.5px;color:var(--text-secondary)">Required: <b>Quantity</b> and at least one of <b>Item Code</b> / <b>Roshen ID</b>.</span>
        <div class="sc-spacer"></div>${savedOpts}
      </div>
      <div class="sc-table-wrap"><table class="sc-table">
        <thead><tr><th style="width:40%">Excel Column</th><th></th><th style="width:45%">ERP Field</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
    </div>

    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="sc-btn primary" data-act="continue">Continue to Preview →</button>
      <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
        <input class="sc-input" data-el="mapname" placeholder="Mapping name (e.g. Roshen July Order)" style="max-width:240px">
        <button class="sc-btn ghost" data-act="savemap">💾 Save mapping</button>
      </div>
    </div>`);

  // read the current selects into an idx->field map
  const readMapping = () => {
    const m = {};
    qsa('select[data-col]', root).forEach((sel) => { if (sel.value && sel.value !== 'ignore') m[Number(sel.dataset.col)] = sel.value; });
    return m;
  };

  wire(root, {
    cancel: handlers.cancel,
    continue: () => handlers.continue(readMapping()),
    savemap: () => {
      const name = (root.querySelector('[data-el="mapname"]').value || '').trim();
      handlers.saveMapping(name, readMapping());
    },
  });

  const saved = root.querySelector('[data-el="saved"]');
  if (saved) saved.addEventListener('change', () => { if (saved.value) handlers.applySaved(saved.value); });
}
