// Delivery-Note import flow: choose PO → upload Excel → map columns (shared
// mapping engine) → review batches + shelf life vs the PO open balance →
// create. All persistence goes through services.
import { mount, wire, delegate, qsa } from '../../utils/dom.js';
import { esc, qty, today } from '../../utils/format.js';
import { loading, emptyState } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { modal } from '../../components/modal/modal.js';
import { orderBadge } from '../../components/table/table.js';
import { shelfChip } from '../../components/table/badges.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';
import { listReceivableOrders, getFulfillment, createDeliveryNote } from '../../services/delivery-note/delivery-note.service.js';
import { parseDeliveryNote } from '../../services/delivery-note/dn-parser.js';
import { DN_MAPPING } from '../../services/delivery-note/dn-mapping.js';
import * as ME from '../../services/import/mapping-engine.js';
import { buildDeliveryNote } from '../../services/delivery-note/dn-validator.js';
import { attachOriginalDocument } from '../../services/attachments/attachments.service.js';

export async function startDnImport(root, ctx) {
  mount(root, loading('Loading orders…'));
  let orders, skus, byRoshen, byCode;
  try {
    [orders, skus] = await Promise.all([listReceivableOrders(), listSkus()]);
    byRoshen = indexByRoshen(skus); byCode = indexByCode(skus);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const state = { order: null, parsed: null, mapByIdx: null, built: null, filename: '' };

  // ---- step 1: choose PO ----
  function chooseOrder() {
    const rows = orders.map((o) => `<tr class="sc-row-link" data-act="pick" data-id="${o.id}">
      <td class="mono"><b>${esc(o.order_number)}</b></td><td>${esc(o.order_date || '')}</td>
      <td>${esc(o.supplier || '')}</td><td>${esc(o.warehouse || '')}</td><td>${orderBadge(o.status)}</td>
    </tr>`).join('') || '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:22px">No PIs are ready for deliveries yet — approve the PI first.</td></tr>';
    mount(root, `
      <div class="sc-card-h"><h3>➕ Add Delivery Note</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="cancel">← Delivery Notes</button></div>
      <div class="sc-card"><div class="sc-card-h" style="margin-bottom:8px"><b>1. Choose the PI this delivery belongs to</b></div>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Order #</th><th>Date</th><th>Supplier</th><th>Warehouse</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`);
    delegate(root, {
      cancel: () => ctx.navigate('delivery-notes'),
      pick: ({ id }) => { state.order = orders.find((o) => String(o.id) === String(id)); uploadStep(); },
    });
  }

  // ---- step 2: upload ----
  function uploadStep() {
    mount(root, `
      <div class="sc-card-h"><h3>➕ Add Delivery Note · ${esc(state.order.order_number)}</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="back">← Change PI</button></div>
      <div class="sc-card"><div class="sc-card-h" style="margin-bottom:8px"><b>2. Upload the supplier Delivery Note Excel</b></div>
        <div class="erp-drop" data-el="drop">
          <div style="font-size:40px;opacity:.6">📄</div>
          <div style="margin-top:10px;font-weight:700;color:var(--text-primary)">Drop the DN .xlsx here or click to browse</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">The file’s columns are matched automatically — you can adjust them in the next step.</div>
          <input type="file" accept=".xlsx,.xls" data-el="file" style="display:none">
        </div></div>`);
    const drop = root.querySelector('[data-el="drop"]'); const file = root.querySelector('[data-el="file"]');
    wire(root, { back: chooseOrder });
    drop.addEventListener('click', () => file.click());
    file.addEventListener('change', () => handle(file.files && file.files[0]));
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  }

  function handle(f) {
    if (!f) return;
    if (typeof window.XLSX === 'undefined') return toast('Excel engine not loaded', 'err');
    const rd = new FileReader();
    rd.onload = (e) => {
      try { state.parsed = parseDeliveryNote(e.target.result, window.XLSX); }
      catch (err) { return toast('Could not read Excel: ' + (err.message || err), 'err'); }
      if (!state.parsed.rows.length) return toast('No data rows found', 'err');
      state.filename = f.name; state.file = f;
      const match = ME.findMatchingMapping(state.parsed.columns, DN_MAPPING);
      state.mapByIdx = match ? ME.mappingToIdx(match.map, state.parsed.columns) : ME.suggestMapping(state.parsed.columns, DN_MAPPING);
      if (match) toast(`Applied saved mapping “${match.name}”`, 'info');
      mapStep();
    };
    rd.readAsArrayBuffer(f);
  }

  // ---- step 3: map ----
  function mapStep() {
    const optionList = (sel) => ['<option value="ignore">— Ignore —</option>']
      .concat(DN_MAPPING.fields.map((fd) => `<option value="${fd.key}" ${sel === fd.key ? 'selected' : ''}>${esc(fd.label)}${fd.required ? ' *' : ''}</option>`)).join('');
    const rows = state.parsed.columns.map((c) => `<tr>
      <td><b>${esc(c.label)}</b>${c.sample ? `<div style="font-size:11px;color:var(--text-muted)">e.g. ${esc(c.sample)}</div>` : ''}</td>
      <td style="text-align:center;color:var(--text-muted)">→</td>
      <td><select class="sc-select" data-col="${c.idx}">${optionList(state.mapByIdx[c.idx])}</select></td></tr>`).join('');
    const saved = ME.listMappings(DN_MAPPING);
    const savedOpts = saved.length
      ? `<select class="sc-select" data-el="saved" style="max-width:220px"><option value="">Apply saved mapping…</option>${saved.map((m) => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')}</select>` : '';
    mount(root, `
      <div class="sc-card-h"><h3>🧭 Match Columns · ${esc(state.order.order_number)}</h3><div class="sc-spacer"></div>
        <span class="mono" style="color:var(--text-muted);font-size:11px">${esc(state.filename)}</span>
        <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Re-upload</button></div>
      <div class="sc-card"><div class="sc-card-h" style="margin-bottom:10px">
        <span style="font-size:12.5px;color:var(--text-secondary)">Required: <b>Roshen ID</b>, <b>Expiry Date</b>, <b>Cartons</b>. Matching is by Roshen ID / Item Code — never description.</span>
        <div class="sc-spacer"></div>${savedOpts}</div>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th style="width:40%">Excel Column</th><th></th><th style="width:45%">Delivery Note Field</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="sc-btn primary" data-act="review">Continue to Review →</button>
        <div style="display:flex;gap:8px;align-items:center;margin-left:auto">
          <input class="sc-input" data-el="mapname" placeholder="Mapping name (e.g. Roshen DN)" style="max-width:240px">
          <button class="sc-btn ghost" data-act="savemap">💾 Save mapping</button>
        </div></div>`);
    const readMap = () => { const m = {}; qsa('select[data-col]', root).forEach((s) => { if (s.value && s.value !== 'ignore') m[Number(s.dataset.col)] = s.value; }); return m; };
    wire(root, {
      back: uploadStep,
      review: () => {
        const m = readMap();
        const miss = ME.requiredMissing(m, DN_MAPPING);
        if (miss.length) return toast('Map required field(s): ' + miss.join(', '), 'err');
        state.mapByIdx = m; reviewStep();
      },
      savemap: () => {
        const name = (root.querySelector('[data-el="mapname"]').value || '').trim();
        if (!name) return toast('Enter a mapping name first', 'err');
        ME.saveMapping(name, ME.idxToLabelMap(readMap(), state.parsed.columns), DN_MAPPING);
        state.mapByIdx = readMap();
        toast(`Mapping “${name}” saved`, 'ok'); mapStep();
      },
    });
    const savedSel = root.querySelector('[data-el="saved"]');
    if (savedSel) savedSel.addEventListener('change', () => { if (savedSel.value) { const sm = saved.find((x) => x.name === savedSel.value); if (sm) { state.mapByIdx = ME.mappingToIdx(sm.map, state.parsed.columns); toast(`Applied “${savedSel.value}”`, 'ok'); mapStep(); } } });
  }

  // ---- step 4: review ----
  async function reviewStep() {
    mount(root, loading('Matching against the purchase order…'));
    let ful;
    try { ful = await getFulfillment(state.order.id); }
    catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
    const built = buildDeliveryNote({ rows: state.parsed.rows, mapByIdx: state.mapByIdx, skuIndex: { byRoshen, byCode }, fulfillment: ful, asOf: today() });
    state.built = built;
    const s = built.summary;

    const lineRows = built.lines.map((l) => {
      const batchRows = l.batches.map((b) => `<tr>
        <td class="mono" style="padding-left:22px">${esc(b.batch_no || '—')}</td>
        <td>${esc(b.expiry_date || '—')}</td>
        <td>${esc(b.manufacturing_date || (b.shelf && b.shelf.mfgKnown ? '' : 'implied'))}</td>
        <td class="num">${qty(b.cases)}</td>
        <td>${shelfChip(b.shelf)}</td>
        <td>${b.belowMinimum ? '<span class="sc-badge closed">⚠ Below min</span>' : ''}</td></tr>`).join('');
      const tag = l.kind === 'additional' ? '<span class="sc-badge closed">Extra (not on PO)</span>'
        : l.overDelivery ? '<span class="sc-badge closed">Over open balance</span>'
        : '<span class="sc-badge confirmed">On PO</span>';
      const open = l.po ? `open ${qty(l.po.open_delivery)}` : '—';
      return `<tr class="sc-row-head">
        <td class="mono"><b>${esc(l.roshen_id || l.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(l.item_code || '')}</div></td>
        <td colspan="2">${esc(l.description || '')}</td>
        <td class="num"><b>${qty(l.totalCases)}</b><div style="font-size:11px;color:var(--text-muted)">${open}</div></td>
        <td colspan="2">${tag}</td></tr>${batchRows}`;
    }).join('');

    const tile = (l, v, cls) => `<div class="sc-sum-card ${cls || ''}"><div class="lbl">${l}</div><div class="val">${v}</div></div>`;
    mount(root, `
      <div class="sc-card-h"><h3>🔍 Review Delivery · ${esc(state.order.order_number)}</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="back">← Mapping</button></div>
      <div class="sc-card"><div class="sc-card-h"><h3>🧾 ${esc(state.parsed.header.dn_number || 'Delivery Note')}</h3><div class="sc-spacer"></div>
        <span style="font-size:12px;color:var(--text-muted)">PO ref ${esc(state.parsed.header.po_reference || '—')} · ${esc(state.parsed.header.dn_date || '')} · ${esc(state.parsed.header.supplier || '')}</span></div>
        <div class="sc-summary">
          ${tile('Lines', s.lineCount)}${tile('Batches', s.batchCount)}${tile('Cartons', qty(s.totalCartons))}
          ${tile('On PO', s.matched)}${tile('Extra', s.additional, s.additional ? 'grand' : '')}
          ${tile('Over balance', s.overDelivery, s.overDelivery ? 'grand' : '')}${tile('Below shelf life', s.belowShelfLife, s.belowShelfLife ? 'grand' : '')}
        </div>
        ${s.belowShelfLife ? '<p style="font-size:12px;color:#F76707;margin:10px 0 0">⚠ Some batches are below the SKU minimum remaining shelf life. They are not rejected here — the warehouse manager decides during Goods Receiving (Accept Exception / Reject), and every exception is audited.</p>' : ''}
      </div>
      <div class="sc-card"><div class="sc-card-h"><h3>📦 Lines &amp; Batches</h3></div>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Batch / Lot</th><th>Expiry</th><th>Mfg</th><th class="num">Cases</th><th>Remaining shelf life</th><th></th></tr></thead><tbody>${lineRows}</tbody></table></div></div>
      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        <button class="sc-btn primary" data-act="create">✅ Create Delivery Note</button>
        <span style="font-size:12px;color:var(--text-secondary)">This records the delivery against ${esc(state.order.order_number)} and updates the remaining quantities.</span>
      </div>`);
    wire(root, { back: mapStep, create: doCreate });
  }

  let creating = false;
  async function doCreate(arg) {
    // wire() invokes handlers with the button's data attributes — only an
    // EXPLICIT boolean true (from the dispute-confirmation modal) may bypass
    // the PO-quantity guard.
    const allowOverDelivery = arg === true;
    if (creating) return;                    // guard against double submit
    creating = true;
    const btn = root.querySelector('[data-act="create"]');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }
    const b = state.built; const h = state.parsed.header;
    try {
      const dn = await createDeliveryNote({
        orderId: state.order.id,
        header: { ...h, source_filename: state.filename, total_cartons: b.summary.totalCartons },
        lines: b.lines, createdBy: 'dn-import', allowOverDelivery,
      });
      if (!(await attachOriginalDocument('delivery_note', dn.id, state.file, 'dn-import')))
        toast('DN created, but attaching the original file failed — add it from the Attachments panel.', 'info');
      toast(`Delivery note ${dn.dn_number} created`, 'ok');
      ctx.navigate('delivery-notes', { view: 'detail', dnId: dn.id });
    } catch (e) {
      creating = false;                      // allow retry on failure
      if (btn) { btn.disabled = false; btn.textContent = '✅ Create Delivery Note'; }
      if (e && e.code === 'OVER_DELIVERY') {
        // blocked by the PO-quantity rule — the user may explicitly record the
        // excess as a disputed over-delivery (it still can never be received)
        modal('⚠ Delivery exceeds the purchase order', `
          <p style="font-size:12.5px;color:var(--text-secondary)">${esc(e.message)}</p>
          <p style="font-size:12.5px;color:var(--text-secondary)">You can record the document anyway: the excess is tracked as a <b>disputed over-delivery</b> and receiving stays capped at the PO quantity — the extra cases can never enter inventory.</p>`, [
          { label: 'Record as disputed over-delivery', cls: 'primary', onClick: () => doCreate(true) },
          { label: 'Back — fix quantities', cls: 'ghost' },
        ]);
        return;
      }
      toast('Create failed: ' + (e.message || e), 'err');
    }
  }

  chooseOrder();
}
