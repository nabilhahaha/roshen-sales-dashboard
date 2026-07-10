// Shelf-Life Master Import tool — reusable. Paste or upload a Roshen shelf-life
// sheet (Description, Unit Weight, Units/Carton, Shelf Life); it matches rows to
// SKU Master (code → remembered mapping → description+pack, with mandatory
// discriminators), previews matched / ambiguous / unmatched / duplicates, lets
// the user map or create SKUs for the leftovers (remembering the mapping), then
// UPDATES Shelf Life only. It never creates duplicate SKUs and never overwrites
// company-specific fields.
import { mount, wire, delegate, qsa } from '../../utils/dom.js';
import { esc } from '../../utils/format.js';
import { loading, emptyState } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { modal } from '../../components/modal/modal.js';
import { listSkus, createSku, listShelfLifeMappings, saveShelfLifeMapping } from '../../services/sku/sku.service.js';
import { matchShelfLifeRows } from '../../services/sku/shelf-life-import.js';
import { applyShelfLifeMatches, planShelfLifeChanges, DEFAULT_MIN_PCT } from '../../services/sku/shelf-life-import.service.js';

const ACTOR = 'Development';

// Parse pasted TSV/CSV. Expects columns: Description, Unit Weight, Units/Carton,
// Shelf Life. A header row (containing "description"/"shelf") is skipped.
function parseSheet(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  lines.forEach((line, i) => {
    const cols = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}|,(?=\s*\S)/);
    const c = cols.map((x) => x.trim());
    if (i === 0 && /descript|shelf|weight|carton/i.test(line) && !/\d+\s*m\b/i.test(line)) return; // header
    if (c.length < 4) return;
    rows.push({ description: c[0], unit_weight: c[1], units_per_carton: c[2], shelf_life: c[3] });
  });
  return rows;
}

export async function startShelfLifeImport(root, ctx) {
  mount(root, loading('Loading SKU Master…'));
  let skus, mappings;
  try { [skus, mappings] = await Promise.all([listSkus({ activeOnly: false }), listShelfLifeMappings().catch(() => [])]); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const state = { rows: [], res: null, manual: {}, remember: {}, overwrite: false }; // manual[rowIdx]=sku_id

  inputStep();

  function inputStep() {
    mount(root, `
      <div class="sc-card-h"><h3>📥 Shelf Life Master Import</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="back">← SKU Master</button></div>
      <div class="sc-card">
        <p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">Paste the Roshen shelf-life sheet (columns: <b>Product Description · Unit Weight · Units/Carton · Shelf Life</b>) or upload an Excel/CSV file. The tool matches each row to SKU Master and updates Shelf Life only — it never creates duplicate SKUs or overwrites other fields.</p>
        <textarea class="sc-input" data-el="paste" rows="10" style="font-family:ui-monospace,Menlo,monospace;font-size:12px" placeholder="CANDY NUT Soft caramel...\t1 kg\t8\t12 m"></textarea>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
          <button class="sc-btn primary" data-act="parse">Preview matches →</button>
          <label class="sc-btn ghost" style="cursor:pointer">📄 Upload Excel/CSV<input type="file" accept=".xlsx,.xls,.csv" data-el="file" style="display:none"></label>
          <span style="font-size:11.5px;color:var(--text-muted)">${skus.length} SKUs · ${mappings.length} remembered mapping(s)</span>
        </div>
      </div>`);
    wire(root, { back: () => ctx.navigate('sku-master'), parse: () => { state.rows = parseSheet(root.querySelector('[data-el="paste"]').value); runMatch(); } });
    const file = root.querySelector('[data-el="file"]');
    file.addEventListener('change', () => { const f = file.files && file.files[0]; if (f) readFile(f); });
  }

  function readFile(f) {
    const rd = new FileReader();
    if (/\.csv$/i.test(f.name)) { rd.onload = () => { state.rows = parseSheet(String(rd.result)); runMatch(); }; rd.readAsText(f); return; }
    if (!window.XLSX) return toast('Excel engine not loaded', 'err');
    rd.onload = () => {
      try {
        const wb = window.XLSX.read(new Uint8Array(rd.result), { type: 'array' });
        const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
        state.rows = aoa.map((r) => ({ description: r[0], unit_weight: r[1], units_per_carton: r[2], shelf_life: r[3] }))
          .filter((r) => r.description && !/descript/i.test(String(r.description)));
        runMatch();
      } catch (e) { toast('Could not read file: ' + (e.message || e), 'err'); }
    };
    rd.readAsArrayBuffer(f);
  }

  function runMatch() {
    if (!state.rows.length) return toast('No rows found — check the pasted format', 'err');
    state.res = matchShelfLifeRows(state.rows, skus, { mappings });
    state.manual = {}; state.remember = {};
    previewStep();
  }

  function previewStep() {
    const r = state.res;
    const manualCount = () => Object.keys(state.manual).length;
    const skuOpts = (sel) => ['<option value="">— map to existing SKU —</option>']
      .concat(skus.slice().sort((a, b) => (a.item_description || '').localeCompare(b.item_description || ''))
        .map((s) => `<option value="${s.id}" ${sel === s.id ? 'selected' : ''}>[${esc(s.item_code)}] ${esc((s.item_description || '').slice(0, 46))}</option>`)).join('');

    // Per-field change plan (exactly what Apply will write).
    const plan = planShelfLifeChanges(r.matched, { overwrite: state.overwrite });
    const planChanges = plan.reduce((a, p) => a + p.fields.filter((f) => f.apply).length, 0);
    const actionChip = (f) => f.apply
      ? `<span class="sc-badge ${f.action.includes('overwrite') ? 'closed' : 'confirmed'}">${esc(f.action)}</span>`
      : `<span class="sc-badge none">${esc(f.action)}</span>`;
    const planRows = plan.flatMap((p) => p.fields.map((f, j) => `<tr>
      ${j === 0 ? `<td class="mono" rowspan="${p.fields.length}" style="vertical-align:top"><b>[${esc(p.sku.item_code)}]</b><div style="font-size:11px;color:var(--text-muted)">${esc((p.sku.item_description || '').slice(0, 38))}</div>
        <span class="sc-badge ${p.via === 'roshen_id' || p.via === 'item_code' ? 'confirmed' : p.via === 'remembered_mapping' ? 'approved' : 'pi'}" style="margin-top:3px">${esc(p.via === 'description+pack' ? 'description' : p.via)}</span></td>` : ''}
      <td>${esc(f.label)}</td>
      <td>${f.current == null ? '<span style="color:var(--text-muted)">—</span>' : esc(String(f.current))}</td>
      <td><b>${esc(String(f.next))}</b></td>
      <td style="font-size:11.5px;color:var(--text-secondary)">${esc(f.source)}</td>
      <td>${actionChip(f)}</td></tr>`)).join('');

    const needsRow = (u, kind) => {
      const i = u.row.i;
      return `<tr><td>#${i + 1}</td><td>${esc(u.row.description)}<div style="font-size:11px;color:var(--text-muted)">${esc(u.row.unit_weight || '')} · ${esc(String(u.row.units_per_carton ?? ''))}/ctn · ${esc(String(u.row.shelf ? u.row.shelf.value + ' ' + u.row.shelf.unit : ''))}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${esc(u.reason || '')}</div></td>
        <td><select class="sc-select sm" data-map="${i}" style="min-width:240px">${skuOpts(state.manual[i] || '')}</select>
          <label style="font-size:11px;color:var(--text-muted);display:block;margin-top:4px"><input type="checkbox" data-remember="${i}" ${state.remember[i] ? 'checked' : ''}> remember this mapping</label></td>
        <td><button class="sc-btn sm ghost" data-act="create" data-i="${i}">＋ Create SKU</button></td></tr>`;
    };

    const section = (title, cls, count, inner) => `<div class="sc-card"><div class="sc-card-h"><h3>${title}</h3><div class="sc-spacer"></div><span class="sc-badge ${cls}">${count}</span></div>${count ? inner : '<p style="font-size:12px;color:var(--text-muted);margin:0">None</p>'}</div>`;

    mount(root, `
      <div class="sc-card-h"><h3>📥 Shelf Life Import · Preview</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="reinput">← Re-paste</button>
        <button class="sc-btn green" style="margin-left:8px" data-act="apply">✅ Apply <span data-el="applyN"></span></button></div>
      <div class="sc-card" style="display:flex;gap:22px;flex-wrap:wrap;align-items:center;font-size:12.5px">
        <div>Total rows: <b>${r.total}</b></div><div>Matched: <b style="color:#2FB344">${r.matched.length}</b></div>
        <div>Changes to apply: <b style="color:#2FB344">${planChanges}</b></div>
        <div>To map: <b style="color:#F76707" data-el="needN">${r.unmatched.length + r.ambiguous.length}</b></div>
        <div>Duplicates: <b>${r.duplicates.length}</b></div><div>Errors: <b>${r.errors.length}</b></div>
        <label style="margin-left:auto;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary);cursor:pointer">
          <input type="checkbox" data-el="overwrite" ${state.overwrite ? 'checked' : ''}> Overwrite existing data
        </label></div>
      ${section('✅ Matched — change plan (Current → New)', 'confirmed', r.matched.length,
        `<div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>SKU · match</th><th>Field</th><th>Current</th><th>New</th><th>Source</th><th>Action</th></tr></thead><tbody>${planRows}</tbody></table></div>
        <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">Default mode fills empty fields only. "Overwrite existing data" also updates differing stored values (Shelf Life, Unit Weight, Units/Carton). Minimum Remaining % is only ever defaulted to ${DEFAULT_MIN_PCT}% when empty — never overwritten.</p>`)}
      <div data-el="needs">${section('⚠ Needs manual mapping (unmatched + ambiguous)', 'closed', r.unmatched.length + r.ambiguous.length,
        `<div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Row</th><th>Sheet product</th><th>Map to existing</th><th>Or create</th></tr></thead><tbody>${[...r.unmatched, ...r.ambiguous].map((u) => needsRow(u)).join('')}</tbody></table></div>`)}</div>
      ${section('🔁 Duplicates (review)', 'draft', r.duplicates.length, `<ul style="margin:0;font-size:12px;color:var(--text-secondary)">${r.duplicates.map((d) => `<li>#${d.row.i + 1} ${esc(d.row.description)} — ${esc(d.reason)}</li>`).join('')}</ul>`)}
      ${section('⛔ Errors', 'draft', r.errors.length, `<ul style="margin:0;font-size:12px;color:var(--text-secondary)">${r.errors.map((e) => `<li>#${e.row.i + 1} ${esc(e.reason)}</li>`).join('')}</ul>`)}`);

    const refreshApplyN = () => { const n = planChanges + manualCount(); root.querySelector('[data-el="applyN"]').textContent = '(' + n + ' changes)'; root.querySelector('[data-el="needN"]').textContent = (r.unmatched.length + r.ambiguous.length - manualCount()); };
    refreshApplyN();

    delegate(root, {
      reinput: inputStep,
      create: ({ i }) => openCreateFromRow(findRow(Number(i))),
      apply: doApply,
    });
    const ow = root.querySelector('[data-el="overwrite"]');
    if (ow) ow.addEventListener('change', () => { state.overwrite = ow.checked; previewStep(); });
    qsa('[data-map]', root).forEach((sel) => sel.addEventListener('change', () => {
      const i = Number(sel.dataset.map); const id = sel.value ? Number(sel.value) : null;
      if (id) state.manual[i] = id; else delete state.manual[i];
      refreshApplyN();
    }));
    qsa('[data-remember]', root).forEach((cb) => cb.addEventListener('change', () => { state.remember[Number(cb.dataset.remember)] = cb.checked; }));
  }

  function findRow(i) { const all = [...state.res.unmatched, ...state.res.ambiguous, ...state.res.matched]; const e = all.find((x) => x.row.i === i); return e ? e.row : null; }

  function openCreateFromRow(row) {
    if (!row) return;
    const wg = row.weight_g;
    const unitOpt = ['Days', 'Months', 'Years'].map((x) => `<option value="${x}" ${row.shelf && row.shelf.unit === x ? 'selected' : ''}>${x}</option>`).join('');
    modal('＋ Create SKU from sheet row', `
      <div style="font-size:12px;color:var(--text-secondary);margin-bottom:8px">${esc(row.description)}</div>
      <div class="sc-form-grid">
        <div class="sc-field"><label>Roshen ID</label><input id="c-roshen" class="sc-input"></div>
        <div class="sc-field"><label>Item Code *</label><input id="c-code" class="sc-input"></div>
        <div class="sc-field" style="grid-column:1/-1"><label>Description *</label><input id="c-desc" class="sc-input" value="${esc(row.description)}"></div>
        <div class="sc-field"><label>Unit Weight (g)</label><input id="c-weight" class="sc-input" type="number" value="${wg != null ? wg : ''}"></div>
        <div class="sc-field"><label>Units / Carton</label><input id="c-units" class="sc-input" type="number" value="${row.units_per_carton != null ? row.units_per_carton : ''}"></div>
        <div class="sc-field"><label>Shelf Life Value</label><input id="c-slv" class="sc-input" type="number" value="${row.shelf ? row.shelf.value : ''}"></div>
        <div class="sc-field"><label>Shelf Life Unit</label><select id="c-slu" class="sc-select">${unitOpt}</select></div>
        <div class="sc-field"><label>Minimum Remaining Shelf Life %</label><input id="c-min" class="sc-input" type="number" min="0" max="100" value="${DEFAULT_MIN_PCT}"></div>
      </div>`, [
      { label: 'Create & match', cls: 'primary', onClick: async () => {
          const g = (id) => (document.getElementById(id) || {}).value;
          try {
            const created = await createSku({ roshen_id: g('c-roshen'), item_code: g('c-code'), item_description: g('c-desc'),
              unit_weight_g: g('c-weight'), units_per_carton: g('c-units'), shelf_life_value: g('c-slv'), shelf_life_unit: g('c-slu'),
              min_remaining_shelf_life_pct: g('c-min') === '' ? DEFAULT_MIN_PCT : g('c-min'), status: 'active' }, ACTOR);
            skus.push(created);
            state.manual[row.i] = created.id; state.remember[row.i] = true;
            toast('SKU created and matched', 'ok');
            previewStep();
          } catch (e) { toast('Create failed: ' + (e.message || e), 'err'); }
        } },
      { label: 'Cancel', cls: 'ghost' },
    ]);
  }

  let applying = false;
  async function doApply() {
    if (applying) return; applying = true;
    try {
      const skuById = {}; skus.forEach((s) => { skuById[s.id] = s; });
      const manualMatches = Object.keys(state.manual).map((i) => {
        const row = findRow(Number(i)); const sku = skuById[state.manual[i]];
        return row && sku ? { row, sku, via: 'manual' } : null;
      }).filter(Boolean);
      const all = [...state.res.matched, ...manualMatches];
      const applied = await applyShelfLifeMatches(all, { actor: ACTOR, overwrite: state.overwrite });
      // remember chosen mappings
      const remembers = Object.keys(state.manual).filter((i) => state.remember[i]);
      for (const i of remembers) { const row = findRow(Number(i)); if (row) { try { await saveShelfLifeMapping({ description: row.description, sku_id: state.manual[i], createdBy: ACTOR }); } catch (e) { /* best-effort */ } } }
      summaryStep(applied, manualMatches.length, remembers.length);
    } catch (e) { toast('Apply failed: ' + (e.message || e), 'err'); applying = false; }
  }

  function summaryStep(applied, manualN, rememberedN) {
    const r = state.res;
    const stillNeed = (r.unmatched.length + r.ambiguous.length) - manualN;
    mount(root, `
      <div class="sc-card-h"><h3>📥 Shelf Life Import · Summary</h3><div class="sc-spacer"></div>
        <button class="sc-btn primary" data-act="done">Done → SKU Master</button></div>
      <div class="sc-card"><div class="sc-summary">
        <div class="sc-sum-card"><div class="lbl">Total in sheet</div><div class="val">${r.total}</div></div>
        <div class="sc-sum-card"><div class="lbl">Matched</div><div class="val">${r.matched.length + manualN}</div></div>
        <div class="sc-sum-card"><div class="lbl">Updated</div><div class="val">${applied.updated}</div></div>
        <div class="sc-sum-card"><div class="lbl">Unchanged</div><div class="val">${applied.unchanged}</div></div>
        <div class="sc-sum-card"><div class="lbl">Min % defaulted</div><div class="val">${applied.defaulted}</div></div>
        <div class="sc-sum-card"><div class="lbl">Pack data filled</div><div class="val">${applied.packFilled}</div></div>
        <div class="sc-sum-card"><div class="lbl">Still unmatched</div><div class="val">${stillNeed}</div></div>
        <div class="sc-sum-card"><div class="lbl">Duplicates</div><div class="val">${r.duplicates.length}</div></div>
        <div class="sc-sum-card"><div class="lbl">Errors</div><div class="val">${r.errors.length}</div></div>
      </div>
      <p style="font-size:12.5px;color:var(--text-secondary);margin:12px 0 0">Updated Shelf Life on ${applied.updated} SKU(s). ${applied.defaulted} SKU(s) defaulted to ${DEFAULT_MIN_PCT}% Minimum Remaining Shelf Life; ${applied.packFilled} SKU(s) had Unit Weight / Units-per-Carton filled from the sheet or description.${applied.overwritten ? ' <b>' + applied.overwritten + '</b> existing value(s) replaced (Overwrite mode was on).' : ' Existing values were not overwritten (fill-empty mode).'} ${manualN} manual mapping(s) applied, ${rememberedN} remembered for future imports. Every change is recorded in the SKU audit history.${stillNeed > 0 ? ' <b>' + stillNeed + '</b> product(s) still need manual mapping — re-run the import to finish them.' : ''}</p>
      ${(applied.packReview && applied.packReview.length) ? `<div style="margin-top:10px;font-size:12px;color:var(--text-secondary)"><b>Pack data needs manual review (${applied.packReview.length}):</b> ${applied.packReview.map((p) => esc(p.item_code)).join(', ')} — the weight / units-per-carton could not be determined confidently; set them in SKU Master.</div>` : ''}</div>`);
    wire(root, { done: () => ctx.navigate('sku-master') });
  }
}
