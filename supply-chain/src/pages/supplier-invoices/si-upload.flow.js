// Upload Supplier Invoice — standalone entry from the Supplier Invoices page.
// Select PDF → parse (dedicated SI parser) → preview every extracted field →
// verify → save the original PDF + all parsed data. Linking is automatic via
// the document's own references (PO ref / DN ref):
//   PI + DN found  → hands off to the full DN-matching flow (same screen the
//                    Delivery Note uses), so the invoice validates line-level.
//   otherwise      → saved as 'Pending Matching' (PI linked when found).
import { mount, wire, qsa } from '../../utils/dom.js';
import { esc, money, qty } from '../../utils/format.js';
import { loading } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { tableWrap } from '../../components/table/table.js';
import { parseInvoicePdf } from '../../services/supplier-invoice/supplier-invoice-parser.js';
import { resolveInvoiceReferences, createSupplierInvoiceFromUpload } from '../../services/supplier-invoice/supplier-invoice.service.js';
import { attachOriginalDocument } from '../../services/attachments/attachments.service.js';
import { setPendingInvoiceFile } from '../delivery-notes/invoice-upload.flow.js';

const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',').pop());
  r.onerror = reject;
  r.readAsDataURL(file);
});

export function startSiUpload(root, ctx) {
  const state = { file: null, parsed: null, link: { order: null, dn: null } };

  uploadStep();

  function uploadStep() {
    mount(root, `
      <div class="sc-card-h"><h3>📄 Upload Supplier Invoice</h3><div class="sc-spacer"></div>
        <button class="sc-btn sm ghost" data-act="back">← Supplier Invoices</button></div>
      <div class="sc-card"><p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">
        Upload the supplier's original invoice PDF. Every field is extracted for verification, the original file is saved with the invoice, and the PI / Delivery Note are linked automatically from the document's own references.</p>
        <div class="erp-drop" data-el="drop">
          <div style="font-size:40px;opacity:.6">🧾</div>
          <div style="margin-top:10px;font-weight:700;color:var(--text-primary)">Drop the supplier invoice PDF here or click to browse</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">.pdf — the original document is preserved exactly as imported</div>
          <input type="file" accept="application/pdf,.pdf" data-el="file" style="display:none">
        </div></div>`);
    const drop = root.querySelector('[data-el="drop"]'); const file = root.querySelector('[data-el="file"]');
    wire(root, { back: () => ctx.navigate('supplier-invoices') });
    drop.addEventListener('click', () => file.click());
    file.addEventListener('change', () => handle(file.files && file.files[0]));
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); });
  }

  async function handle(f) {
    if (!f) return;
    if (!window.pdfjsLib) return toast('PDF engine not loaded', 'err');
    state.file = f;
    mount(root, loading('Reading invoice PDF…'));
    const rd = new FileReader();
    rd.onload = async (e) => {
      try { state.parsed = await parseInvoicePdf(e.target.result, window.pdfjsLib); }
      catch (err) { toast('Could not read PDF: ' + (err.message || err), 'err'); return uploadStep(); }
      try { state.link = await resolveInvoiceReferences(state.parsed.header); }
      catch (err) { state.link = { order: null, dn: null }; }
      previewStep();
    };
    rd.readAsArrayBuffer(f);
  }

  function previewStep() {
    const p = state.parsed, h = p.header, { order, dn } = state.link;
    const hf = (label, key, val, type) => `<div class="sc-field"><label>${label}</label><input class="sc-input" data-h="${key}" ${type ? `type="${type}"` : ''} value="${esc(val == null ? '' : val)}"></div>`;

    let linkBanner;
    if (dn && order) {
      linkBanner = `<div class="sc-locked-banner" style="background:rgba(47,179,68,.08);border-color:rgba(47,179,68,.35);color:var(--text-primary)">
        🔗 Matching documents found: PI <b>&nbsp;${esc(order.order_number)}&nbsp;</b> · Delivery Note <b>&nbsp;${esc(dn.dn_number)}&nbsp;</b> — continue to validate the invoice line-by-line against the delivery.</div>`;
    } else if (order) {
      linkBanner = `<div class="sc-locked-banner" style="background:rgba(25,113,194,.08);border-color:rgba(25,113,194,.3);color:var(--text-primary)">
        🔗 PI <b>&nbsp;${esc(order.order_number)}&nbsp;</b> found and will be linked. Delivery Note ${esc(h.dn_reference || '—')} is not in the system yet — the invoice is saved as <b>&nbsp;Pending Matching</b>.</div>`;
    } else {
      linkBanner = `<div class="sc-locked-banner">⏳ No matching PI (${esc(h.po_reference || '—')}) or Delivery Note (${esc(h.dn_reference || '—')}) in the system yet — the invoice is saved as <b>&nbsp;Pending Matching&nbsp;</b> and can be matched once they arrive.</div>`;
    }

    const lineRows = (p.lines || []).map((l) => `<tr>
        <td class="num">${esc(String(l.idx))}</td>
        <td style="font-size:12px;min-width:240px">${esc(l.description || '')}</td>
        <td class="num">${money(l.unit_price)}</td>
        <td class="num">${qty(l.quantity)}</td>
        <td class="num">${money(l.taxable_amount)}</td>
        <td class="num">${l.vat_percent != null ? esc(String(l.vat_percent)) + '%' : '—'}</td>
        <td class="num">${money(l.vat_amount)}</td>
        <td class="num"><b>${money(l.line_total)}</b></td></tr>`).join('')
      || '<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:16px">No line items detected — verify the totals below.</td></tr>';

    mount(root, `
      <div class="sc-card-h"><h3>🧾 Verify Supplier Invoice ${esc(h.invoice_number || '')}</h3><div class="sc-spacer"></div>
        <span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(state.file.name)}</span>
        <button class="sc-btn sm ghost" style="margin-left:10px" data-act="reupload">← Re-upload</button></div>
      ${linkBanner}
      <div class="sc-card"><div class="sc-card-h"><h3>Invoice details</h3><div class="sc-spacer"></div>
        <span style="font-size:11px;color:var(--text-muted)">read from the PDF — correct anything before saving</span></div>
        <div class="sc-form-grid">
          ${hf('Invoice Number', 'invoice_number', h.invoice_number)}
          ${hf('Invoice Date', 'invoice_date', h.invoice_date, 'date')}
          ${hf('Due Date', 'due_date', h.due_date, 'date')}
          ${hf('Payment Terms', 'payment_terms', h.payment_terms)}
          ${hf('Supplier', 'supplier', h.supplier)}
          ${hf('Buyer', 'buyer', h.buyer)}
          ${hf('PO / PI Reference', 'po_reference', h.po_reference)}
          ${hf('DN Reference', 'dn_reference', h.dn_reference)}
          ${hf('Seller VAT (TRN)', 'seller_vat', h.seller_vat)}
          ${hf('Seller CR', 'seller_cr', h.seller_cr)}
          ${hf('Buyer VAT (TRN)', 'buyer_vat', h.buyer_vat)}
          ${hf('Notes (document)', 'doc_notes', h.doc_notes)}
        </div></div>
      <div class="sc-card"><div class="sc-card-h"><h3>Line items (${(p.lines || []).length})</h3><div class="sc-spacer"></div>
        <span style="font-size:11px;color:var(--text-muted)">exactly as the document reads</span></div>
        ${tableWrap(`<table class="sc-table"><thead><tr><th>#</th><th>Nature of goods or services</th><th class="num">Unit Price</th><th class="num">Quantity</th><th class="num">Taxable Amount</th><th class="num">VAT %</th><th class="num">VAT</th><th class="num">Subtotal (incl. VAT)</th></tr></thead><tbody>${lineRows}</tbody></table>`)}
        <div class="sc-summary" style="margin-top:10px">
          <div class="sc-sum-card"><div class="lbl">Total Taxable (net)</div><div class="val">${money(p.totals.taxable)}</div></div>
          <div class="sc-sum-card"><div class="lbl">Total VAT</div><div class="val">${money(p.totals.vat)}</div></div>
          <div class="sc-sum-card grand"><div class="lbl">Total Amount Due</div><div class="val">${money(p.totals.grand)}</div></div>
        </div></div>
      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" data-el="actions">
        ${dn && order
          ? `<button class="sc-btn primary" data-act="matchflow">🔗 Continue — validate against ${esc(dn.dn_number)}</button>
             <button class="sc-btn ghost" data-act="savepending">Save without matching</button>`
          : `<button class="sc-btn primary" data-act="savepending">💾 Save Invoice${order ? ' (linked to ' + esc(order.order_number) + ')' : ' — Pending Matching'}</button>`}
        <button class="sc-btn ghost" style="margin-left:auto" data-act="cancel">Cancel</button>
      </div>`);

    wire(root, {
      reupload: uploadStep,
      cancel: () => ctx.navigate('supplier-invoices'),
      matchflow: () => {
        // full line-level matching against the DN — the same verified flow the
        // Delivery Note screen uses; it returns to Supplier Invoices when done.
        setPendingInvoiceFile(state.file);
        ctx.navigate('delivery-notes', { view: 'invoice', dnId: state.link.dn.id, returnTo: 'supplier-invoices' });
      },
      savepending: () => savePending(),
    });
  }

  let saving = false;
  async function savePending() {
    if (saving) return;
    saving = true;
    qsa('[data-el="actions"] .sc-btn', root).forEach((b) => (b.disabled = true));
    const p = state.parsed;
    // fold the verified header inputs back into the parsed header
    qsa('[data-h]', root).forEach((n) => { p.header[n.dataset.h] = n.value || null; });
    const { order } = state.link;
    try {
      const doc = { name: state.file.name, mime: state.file.type || 'application/pdf', size: state.file.size, base64: await fileToBase64(state.file) };
      const lines = (p.lines || []).map((l) => ({
        line_no: l.idx, description: l.description,
        invoiced_cases: l.quantity, case_price: l.unit_price,
        taxable_amount: l.taxable_amount, vat_percent: l.vat_percent, vat_amount: l.vat_amount, line_total: l.line_total,
      }));
      const invRow = await createSupplierInvoiceFromUpload({
        orderId: order ? order.id : null, deliveryNoteId: null,
        header: p.header, totals: p.totals, lines, document: doc, docType: 'invoice',
        extracted: { header: p.header, totals: p.totals, lines: p.lines },
        validation: { pending: true, pi_found: !!order, dn_found: false, po_reference: p.header.po_reference, dn_reference: p.header.dn_reference },
        status: 'Pending Matching', createdBy: 'si-upload',
      });
      if (!(await attachOriginalDocument('supplier_invoice', invRow.id, state.file, 'si-upload')))
        toast('Invoice saved, but attaching the original PDF failed — add it from the Attachments panel.', 'info');
      toast(`Invoice ${p.header.invoice_number || ''} saved · Pending Matching${order ? ' · linked to ' + order.order_number : ''}`, 'ok');
      ctx.navigate('supplier-invoices');
    } catch (e) {
      saving = false;
      qsa('[data-el="actions"] .sc-btn', root).forEach((b) => (b.disabled = false));
      toast('Save failed: ' + (e.message || e), 'err');
    }
  }
}
