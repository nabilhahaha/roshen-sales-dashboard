// Upload Supplier Invoice (PDF) → extract → verify/bind → validate vs the DN →
// store the original file for audit + the extracted data + validation outcome.
// The supplier invoice is a received document, never created in the ERP.
import { mount, wire, delegate, qsa } from '../../utils/dom.js';
import { esc, money, qty, lineKey as keyOf } from '../../utils/format.js';
import { loading, emptyState } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { getDeliveryNote } from '../../services/delivery-note/delivery-note.service.js';
import { priceIndex } from '../../services/fulfillment/fulfillment.service.js';
import { parseInvoicePdf } from '../../services/supplier-invoice/supplier-invoice-parser.js';
import { compareInvoiceToDeliveryNote } from '../../services/supplier-invoice/invoice-compare.js';
import { createSupplierInvoiceFromUpload } from '../../services/supplier-invoice/supplier-invoice.service.js';

// read a File as base64 (no data: prefix)
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',').pop());
  r.onerror = reject;
  r.readAsDataURL(file);
});

const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
function similarity(a, b) {
  const ta = new Set(tokens(a)), tb = tokens(b); if (!tb.length) return 0;
  let hit = 0; tb.forEach((w) => { if (ta.has(w)) hit++; }); return hit / Math.max(ta.size, tb.length);
}

export async function startInvoiceUpload(root, ctx, dnId) {
  mount(root, loading('Loading delivery note…'));
  let dn, prices;
  try { dn = await getDeliveryNote(dnId); prices = await priceIndex(dn.order_id).catch(() => ({})); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  // DN lines (binding targets) with expected value from PO price
  const dnLines = dn.items.map((it) => {
    const key = keyOf(it.roshen_id, it.item_code);
    const cartons = (it.batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    const price = Number(prices[key] || 0);
    return { key, roshen_id: it.roshen_id, item_code: it.item_code, description: it.description, cartons, price, lineNet: +(cartons * price).toFixed(2) };
  });
  const expectedNet = +dnLines.reduce((a, l) => a + l.lineNet, 0).toFixed(2);
  const dnCtx = { dnNumber: dn.dn_number, poReference: dn.po_reference, expectedNet, lineCount: dnLines.length };

  const state = { parsed: null, file: null, binds: {} };

  uploadStep();

  function uploadStep() {
    mount(root, `
      <div class="sc-card-h"><h3>📄 Upload Supplier Invoice · ${esc(dn.dn_number)}</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="back">← Delivery Note</button></div>
      <div class="sc-card"><p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">The supplier invoice is received as a PDF. Upload it — the ERP stores the original for audit, extracts the data, and validates it against this delivery note. (ZATCA XML support can be added later.)</p>
        <div class="erp-drop" data-el="drop">
          <div style="font-size:40px;opacity:.6">🧾</div>
          <div style="margin-top:10px;font-weight:700;color:var(--text-primary)">Drop the supplier invoice PDF here or click to browse</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">.pdf — the original file is attached to the invoice record</div>
          <input type="file" accept="application/pdf,.pdf" data-el="file" style="display:none">
        </div></div>`);
    const drop = root.querySelector('[data-el="drop"]'); const file = root.querySelector('[data-el="file"]');
    wire(root, { back: () => ctx.navigate('delivery-notes', { view: 'detail', dnId }) });
    drop.addEventListener('click', () => file.click());
    file.addEventListener('change', () => handle(file.files && file.files[0]));
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  }

  function handle(f) {
    if (!f) return;
    if (!window.pdfjsLib) return toast('PDF engine not loaded', 'err');
    state.file = f;
    mount(root, loading('Reading invoice PDF…'));
    const rd = new FileReader();
    rd.onload = async (e) => {
      try { state.parsed = await parseInvoicePdf(e.target.result, window.pdfjsLib); }
      catch (err) { toast('Could not read PDF: ' + (err.message || err), 'err'); return uploadStep(); }
      // suggest a DN-line binding per invoice line (by description similarity)
      state.parsed.lines.forEach((il, i) => {
        let best = null, score = 0.15;
        dnLines.forEach((dl) => { const s = similarity(dl.description, il.description); if (s > score) { score = s; best = dl.key; } });
        state.binds[i] = best;
      });
      reviewStep();
    };
    rd.readAsArrayBuffer(f);
  }

  function reviewStep() {
    const p = state.parsed;
    const hf = (label, key, val, type) => `<div class="sc-field"><label>${label}</label><input class="sc-input" data-h="${key}" ${type ? `type="${type}"` : ''} value="${esc(val == null ? '' : val)}"></div>`;
    const bindOpts = (sel) => ['<option value="">— unbound —</option>']
      .concat(dnLines.map((d) => `<option value="${esc(d.key)}" ${sel === d.key ? 'selected' : ''}>${esc(d.roshen_id || d.item_code)} · ${esc((d.description || '').slice(0, 40))} (${qty(d.cartons)} ctn)</option>`)).join('');

    const lineRows = p.lines.map((l, i) => `<tr>
      <td class="num">${l.idx}</td>
      <td><input class="sc-input sm" data-l="${i}" data-f="description" value="${esc(l.description)}" style="min-width:220px"></td>
      <td><input class="sc-input sm num" data-l="${i}" data-f="unit_price" value="${esc(l.unit_price)}" style="max-width:80px"></td>
      <td><input class="sc-input sm num" data-l="${i}" data-f="quantity" value="${esc(l.quantity)}" style="max-width:90px"></td>
      <td><input class="sc-input sm num" data-l="${i}" data-f="taxable_amount" value="${esc(l.taxable_amount)}" style="max-width:100px"></td>
      <td><input class="sc-input sm num" data-l="${i}" data-f="vat_amount" value="${esc(l.vat_amount)}" style="max-width:90px"></td>
      <td><select class="sc-select sm" data-bind="${i}">${bindOpts(state.binds[i])}</select></td></tr>`).join('');

    mount(root, `
      <div class="sc-card-h"><h3>🧾 Verify Supplier Invoice · ${esc(dn.dn_number)}</h3><div class="sc-spacer"></div>
        <span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(state.file.name)}</span>
        <button class="sc-btn sm ghost" style="margin-left:10px" data-act="reupload">← Re-upload</button></div>
      <div class="sc-card"><div class="sc-card-h"><h3>Extracted header</h3><div class="sc-spacer"></div>
        <span style="font-size:11px;color:var(--text-muted)">extracted from the PDF — correct anything before validating</span></div>
        <div class="sc-form-grid">
          ${hf('Invoice Number', 'invoice_number', p.header.invoice_number)}
          ${hf('Invoice Date', 'invoice_date', p.header.invoice_date, 'date')}
          ${hf('Supplier', 'supplier', p.header.supplier)}
          ${hf('Buyer', 'buyer', p.header.buyer)}
          ${hf('PO Reference', 'po_reference', p.header.po_reference)}
          ${hf('DN Reference', 'dn_reference', p.header.dn_reference)}
          ${hf('Total Taxable (net)', 'taxable', p.totals.taxable, 'number')}
          ${hf('Total VAT', 'vat', p.totals.vat, 'number')}
          ${hf('Grand Total', 'grand', p.totals.grand, 'number')}
        </div></div>
      <div class="sc-card"><div class="sc-card-h"><h3>Line items</h3><div class="sc-spacer"></div>
        <span style="font-size:11px;color:var(--text-muted)">bind each invoice line to the delivery-note SKU it corresponds to</span></div>
        <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>#</th><th>Description (invoice)</th><th class="num">Unit</th><th class="num">Qty</th><th class="num">Taxable</th><th class="num">VAT</th><th>Bind to DN SKU</th></tr></thead><tbody>${lineRows}</tbody></table></div></div>
      <div class="sc-card" data-el="validation"></div>
      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" data-el="actions"></div>`);

    delegate(root, { reupload: uploadStep });
    renderValidation();
    qsa('[data-h],[data-l],[data-bind]', root).forEach((n) => n.addEventListener('change', () => { syncFromInputs(); renderValidation(); }));
  }

  function syncFromInputs() {
    const p = state.parsed;
    qsa('[data-h]', root).forEach((n) => {
      const k = n.dataset.h;
      if (['taxable', 'vat', 'grand'].includes(k)) p.totals[k] = n.value === '' ? null : Number(n.value);
      else p.header[k] = n.value || null;
    });
    qsa('[data-l]', root).forEach((n) => {
      const i = Number(n.dataset.l), f = n.dataset.f;
      if (f === 'description') p.lines[i][f] = n.value;
      else p.lines[i][f] = n.value === '' ? null : Number(n.value);
    });
    qsa('[data-bind]', root).forEach((n) => { state.binds[Number(n.dataset.bind)] = n.value || null; });
  }

  function renderValidation() {
    const cmp = compareInvoiceToDeliveryNote(state.parsed, dnCtx);
    state.cmp = cmp;
    const row = (c) => `<tr><td>${esc(c.label)}</td><td>${typeof c.expected === 'number' ? money(c.expected) : esc(c.expected)}</td>
      <td>${typeof c.actual === 'number' ? money(c.actual) : esc(c.actual)}</td>
      <td>${c.ok == null ? '<span class="sc-badge none">n/a</span>' : c.ok ? '<span class="sc-badge confirmed">✓</span>' : '<span class="sc-badge closed">✗</span>'}</td></tr>`;
    root.querySelector('[data-el="validation"]').innerHTML = `
      <div class="sc-card-h"><h3>📊 Validation vs Delivery Note</h3><div class="sc-spacer"></div>
        ${cmp.ok ? '<span class="sc-badge confirmed">✓ Matches</span>' : '<span class="sc-badge closed">⚠ Differences</span>'}</div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Check</th><th>Expected (DN/PO)</th><th>Invoice</th><th>Result</th></tr></thead><tbody>${['dn_ref', 'po_ref', 'value', 'vat', 'lines'].map((k) => row(cmp.checks.find((c) => c.key === k))).join('')}</tbody></table></div>
      <div style="font-size:12px;color:var(--text-secondary);margin-top:8px">DN expected net: <b>${money(cmp.expectedNet)} SAR</b> · invoice net: <b>${money(cmp.invoiceNet)} SAR</b> · difference: <b style="color:${Math.abs(cmp.valueDiff) < 1 ? 'inherit' : '#F76707'}">${money(cmp.valueDiff)} SAR</b></div>`;

    const actions = root.querySelector('[data-el="actions"]');
    if (cmp.ok) {
      actions.innerHTML = '<button class="sc-btn green" data-act="save-matched">✅ Save &amp; Match Invoice</button><span style="font-size:12px;color:var(--text-secondary)">Storing the invoice as Matched unlocks Goods Receiving for this delivery note.</span>';
    } else {
      actions.innerHTML = '<button class="sc-btn primary" data-act="save-disputed">💾 Save as Disputed</button>' +
        '<button class="sc-btn ghost" data-act="save-override">Accept differences &amp; Match</button>' +
        '<span style="font-size:12px;color:var(--text-secondary)">Review the differences. Disputed keeps the record but does not unlock receiving; Accept records an override (audited).</span>';
    }
    wire(actions, {
      'save-matched': () => save('Matched', false),
      'save-disputed': () => save('Disputed', false),
      'save-override': () => save('Matched', true),
    });
  }

  let saving = false;
  async function save(status, override) {
    if (saving) return; saving = true;
    qsa('[data-el="actions"] .sc-btn', root).forEach((b) => (b.disabled = true));
    try {
      syncFromInputs();
      const p = state.parsed;
      const base64 = await fileToBase64(state.file);
      const doc = { name: state.file.name, mime: state.file.type || 'application/pdf', size: state.file.size, base64 };
      const lines = p.lines.map((il, i) => {
        const dl = dnLines.find((d) => d.key === state.binds[i]) || null;
        return {
          roshen_id: dl ? dl.roshen_id : null, item_code: dl ? dl.item_code : null,
          description: il.description,
          invoiced_cases: dl ? dl.cartons : 0,           // ledger balance is in cartons
          case_price: dl ? dl.price : null,
          taxable_amount: il.taxable_amount, vat_percent: il.vat_percent, vat_amount: il.vat_amount, line_total: il.line_total,
        };
      });
      const validation = { ...state.cmp, override: !!override };
      await createSupplierInvoiceFromUpload({
        orderId: dn.order_id, deliveryNoteId: dn.id, header: p.header, totals: p.totals,
        lines, document: doc, extracted: { header: p.header, totals: p.totals, lines: p.lines }, validation, status, createdBy: 'invoice-upload',
      });
      toast('Supplier invoice saved · ' + status, status === 'Matched' ? 'ok' : 'info');
      ctx.navigate('delivery-notes', { view: 'detail', dnId });
    } catch (e) {
      toast('Save failed: ' + (e.message || e), 'err'); saving = false;
      qsa('[data-el="actions"] .sc-btn', root).forEach((b) => (b.disabled = false));
    }
  }
}
