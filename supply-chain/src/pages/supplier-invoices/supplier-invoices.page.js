// Supplier Invoices — a first-class module for the received commercial
// documents. Lists every invoice / credit note / debit note across POs and
// opens a detail screen with the line-level match (PO→DN→SI), variance badges,
// the dispute register, the audit trail and the full lifecycle actions
// (edit / cancel / replace / credit note / debit note / re-check). Pages talk
// only to services.
import { mount, delegate, wire, qsa } from '../../utils/dom.js';
import { esc, money, qty, normRoshen } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { statusBadge } from '../../components/table/badges.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { printSupplierInvoice } from '../../utils/documents.js';
import { attachmentsPanel } from '../../components/attachments/attachments-panel.js';
import {
  listInvoices, getInvoice, getInvoiceDocument, listInvoiceAudit,
  matchInvoiceLineLevel, editSupplierInvoice, cancelSupplierInvoice, createAdjustmentNote,
} from '../../services/supplier-invoice/supplier-invoice.service.js';
import { disputeInvoiceDifferences, listInvoiceDisputes, closeInvoiceDispute } from '../../services/supplier-invoice/si-dispute.service.js';

const ACTOR = 'Development';
const DOC_LABEL = { invoice: 'Invoice', credit_note: 'Credit Note', debit_note: 'Debit Note' };
const docChip = (t) => `<span class="sc-badge ${t === 'credit_note' ? 'closed' : t === 'debit_note' ? 'approved' : 'none'}">${DOC_LABEL[t] || 'Invoice'}</span>`;

export async function render(root, ctx) {
  const view = (ctx.params && ctx.params.view) || 'list';
  if (view === 'detail' && ctx.params.invoiceId) return renderInvoiceDetail(root, ctx, ctx.params.invoiceId);
  return renderList(root, ctx);
}

// ---- list -----------------------------------------------------------
async function renderList(root, ctx) {
  mount(root, loading('Loading supplier invoices…'));
  let invoices;
  try { invoices = await listInvoices(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const rows = invoices.map((i) => `<tr class="sc-row-link" data-act="open" data-id="${i.id}">
      <td class="mono"><b>${esc(i.invoice_number)}</b></td>
      <td>${docChip(i.doc_type)}</td>
      <td>${esc(i.invoice_date || '')}</td>
      <td class="mono">${esc((i.order && i.order.order_number) || '')}</td>
      <td class="mono">${esc((i.delivery_note && i.delivery_note.dn_number) || '—')}</td>
      <td>${esc(i.supplier || '')}</td>
      <td class="num">${money(i.total_taxable)}</td>
      <td class="num">${money(i.grand_total)}</td>
      <td>${statusBadge(i.status)}</td>
    </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:22px">No supplier invoices yet — upload one from a delivery note to begin.</td></tr>';

  const counts = invoices.reduce((a, i) => { a[i.status] = (a[i.status] || 0) + 1; return a; }, {});
  const chips = ['Matched', 'Partially Matched', 'Disputed', 'Imported'].filter((s) => counts[s])
    .map((s) => `${statusBadge(s)}&nbsp;${counts[s]}`).join('&nbsp;&nbsp;');

  mount(root, `
    <div class="sc-card-h"><h3>🧾 Supplier Invoices</h3>
      <span class="sc-badge none" style="margin-left:8px">${invoices.length}</span>
      <div class="sc-spacer"></div>
      <span style="font-size:12px">${chips}</span></div>
    <div class="sc-card">
      <p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Each supplier invoice is checked line-by-line against its delivery note and the PI. Upload a new invoice from its delivery note.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr>
        <th>Number</th><th>Type</th><th>Date</th><th>PI</th><th>Delivery Note</th><th>Supplier</th>
        <th class="num">Net</th><th class="num">Grand</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody></table>`)}
    </div>`);

  delegate(root, { open: ({ id }) => ctx.navigate('supplier-invoices', { view: 'detail', invoiceId: id }) });
}

// ---- detail ---------------------------------------------------------
async function renderInvoiceDetail(root, ctx, invoiceId) {
  mount(root, loading('Loading invoice…'));
  let inv, audit, disputes, matchResult;
  try {
    inv = await getInvoice(invoiceId);
    [audit, disputes] = await Promise.all([
      listInvoiceAudit(invoiceId).catch(() => []),
      listInvoiceDisputes({ invoiceId }).catch(() => []),
    ]);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const isNote = inv.doc_type !== 'invoice';
  const editable = !isNote && !['Cancelled', 'Replaced'].includes(inv.status);
  const cancellable = !['Cancelled', 'Replaced'].includes(inv.status);
  const sm = inv.match_summary || {};
  const openDisputes = disputes.filter((d) => d.status === 'Open');

  const z = inv.zatca || {};
  const lineRows = (inv.items || []).map((l) => {
    const ms = l.match_status || 'bound';
    return `<tr>
      <td class="mono"><b>${esc(l.roshen_id || l.item_code || '')}</b><div style="font-size:11px;color:var(--text-muted)">${esc(l.item_code || '')}</div></td>
      <td>${esc(l.description || '')}</td>
      <td class="num">${qty(l.invoiced_cases)}</td>
      <td class="num">${l.expected_cases == null ? '—' : qty(l.expected_cases)}</td>
      <td class="num">${money(l.case_price)}${l.price_variance ? `<div style="font-size:10.5px;color:#F76707">Δ ${money(l.price_variance)}</div>` : ''}</td>
      <td class="num">${money(l.taxable_amount)}</td>
      <td class="num">${money(l.vat_amount)}${l.tax_variance ? `<div style="font-size:10.5px;color:#F76707">Δ ${money(l.tax_variance)}</div>` : ''}</td>
      <td>${matchChip(ms)}</td></tr>`;
  }).join('');

  const disputeCard = disputes.length ? `<div class="sc-card"><div class="sc-card-h"><h3>⚖ Disputes</h3><div class="sc-spacer"></div>
      <span class="sc-badge ${openDisputes.length ? 'closed' : 'confirmed'}">${openDisputes.length} open</span></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Line</th><th>Kind</th><th class="num">Expected</th><th class="num">Invoiced</th><th class="num">Δ Value</th><th>Status</th><th></th></tr></thead>
      <tbody>${disputes.map((d) => `<tr>
        <td class="mono">${esc(d.roshen_id || d.item_code || '—')}</td>
        <td>${disputeKind(d.kind)}</td>
        <td class="num">${d.expected_qty == null ? '—' : qty(d.expected_qty)}${d.expected_price != null ? ' @ ' + money(d.expected_price) : ''}</td>
        <td class="num">${d.invoiced_qty == null ? '—' : qty(d.invoiced_qty)}${d.invoiced_price != null ? ' @ ' + money(d.invoiced_price) : ''}</td>
        <td class="num">${d.value_delta == null ? '—' : money(d.value_delta)}</td>
        <td>${d.status === 'Open' ? '<span class="sc-badge closed">Open</span>' : `<span class="sc-badge confirmed">${esc(d.resolution || 'Resolved')}</span>`}</td>
        <td>${d.status === 'Open' ? `<button class="sc-btn sm ghost" data-act="closedispute" data-id="${d.id}">Close</button>` : ''}</td></tr>`).join('')}</tbody></table></div></div>` : '';

  const auditCard = `<div class="sc-card"><div class="sc-card-h"><h3>🕓 Audit Trail</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${audit.length}</span></div>
    ${audit.length ? `<div class="erp-rev-timeline">${audit.map((a) => `<div class="erp-rev">
      <div class="erp-rev-h"><b>${esc(actionLabel(a.action))}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(a.actor || '—')} · ${esc(String(a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      ${a.note ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(a.note)}</div>` : ''}</div>`).join('')}</div>`
      : '<p style="font-size:12px;color:var(--text-muted);margin:0">No actions recorded yet.</p>'}</div>`;

  const actionBtns = [
    '<button class="sc-btn sm ghost" data-act="print">🖨 Print</button>',
    !isNote ? '<button class="sc-btn sm ghost" data-act="rematch">🔗 Re-check match</button>' : '',
    (!isNote && sm.hardVariances > 0 && cancellable) ? '<button class="sc-btn sm ghost" data-act="dispute">⚖ Raise disputes</button>' : '',
    editable ? '<button class="sc-btn sm ghost" data-act="edit">✏️ Edit</button>' : '',
    !isNote && cancellable ? '<button class="sc-btn sm ghost" data-act="credit">➖ Credit Note</button>' : '',
    !isNote && cancellable ? '<button class="sc-btn sm ghost" data-act="debit">➕ Debit Note</button>' : '',
    inv.document_path ? '<button class="sc-btn sm ghost" data-act="viewdoc">📎 Original PDF</button>' : '',
    cancellable ? '<button class="sc-btn sm ghost" data-act="cancel">✖ Cancel</button>' : '',
  ].filter(Boolean).join('');

  const matchBanner = isNote
    ? `<div class="sc-card" style="border-left:3px solid ${inv.doc_type === 'credit_note' ? '#E8590C' : '#1971C2'}"><b>${docChip(inv.doc_type)} adjustment</b>
        <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0">This ${DOC_LABEL[inv.doc_type].toLowerCase()} adjusts invoice <b>${esc((inv.parent_invoice_id && '#' + inv.parent_invoice_id) || '')}</b> and nets automatically in the PO invoiced balance.${inv.adjustment_reason ? ' Reason: ' + esc(inv.adjustment_reason) : ''}</p></div>`
    : (sm.hardVariances > 0
      ? `<div class="sc-card" style="border-left:3px solid #F76707"><b>⚠ Reconciliation variances</b>
          <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0">${sm.qty_variance || 0} qty · ${sm.price_variance || 0} price · ${sm.tax_variance || 0} tax · ${sm.extra || 0} extra line(s). Net billed <b>${money(sm.invoicedNet)}</b> vs expected <b>${money(sm.expectedNet)}</b> (Δ ${money(sm.valueDiff)}). Raise disputes to hold the invoice, or edit / replace it.</p></div>`
      : (inv.status === 'Partially Matched'
        ? `<div class="sc-card" style="border-left:3px solid #1971C2"><b>Partial invoice</b>
            <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0">This invoice bills part of the delivery. ${sm.missing || 0} delivered line(s) remain open to invoice; no variances found.</p></div>`
        : ''));

  mount(root, `
    <div class="sc-card-h"><h3>🧾 ${esc(inv.invoice_number)} ${docChip(inv.doc_type)}</h3><div class="sc-spacer"></div>
      ${statusBadge(inv.status)}<span style="margin-left:8px">${actionBtns}</span>
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Invoices</button></div>
    ${matchBanner}
    <div class="sc-card"><div class="sc-form-grid">
      <div class="sc-field"><label>PI</label><input class="sc-input" readonly value="${esc((inv.order && inv.order.order_number) || '—')}"></div>
      <div class="sc-field"><label>Delivery Note</label><input class="sc-input" readonly value="${esc((inv.delivery_note && inv.delivery_note.dn_number) || inv.dn_reference || '—')}"></div>
      <div class="sc-field"><label>Invoice Date</label><input class="sc-input" readonly value="${esc(inv.invoice_date || '—')}"></div>
      <div class="sc-field"><label>Supply Date</label><input class="sc-input" readonly value="${esc(inv.supply_date || '—')}"></div>
      <div class="sc-field"><label>Supplier</label><input class="sc-input" readonly value="${esc(inv.supplier || '—')}"></div>
      <div class="sc-field"><label>Buyer</label><input class="sc-input" readonly value="${esc(inv.buyer || '—')}"></div>
      <div class="sc-field"><label>Due Date</label><input class="sc-input" readonly value="${esc(inv.due_date || '—')}"></div>
      <div class="sc-field"><label>Payment Terms</label><input class="sc-input" readonly value="${esc(inv.payment_terms || '—')}"></div>
      <div class="sc-field"><label>Net / VAT / Grand</label><input class="sc-input" readonly value="${money(inv.total_taxable)} / ${money(inv.total_vat)} / ${money(inv.grand_total)} ${esc(inv.currency || 'SAR')}"></div>
      <div class="sc-field"><label>Seller VAT (ZATCA)</label><input class="sc-input" readonly value="${esc(z.seller_vat || inv.seller_vat || '—')}"></div>
      <div class="sc-field"><label>Seller CR</label><input class="sc-input" readonly value="${esc(z.seller_cr || inv.seller_cr || '—')}"></div>
      <div class="sc-field"><label>Buyer VAT (ZATCA)</label><input class="sc-input" readonly value="${esc(z.buyer_vat || inv.buyer_vat || '—')}"></div>
    </div>
    ${inv.doc_notes ? `<div style="font-size:11.5px;color:var(--text-secondary);margin-top:8px">Document notes: <i>${esc(inv.doc_notes)}</i></div>` : ''}</div>
    <div class="sc-card"><div class="sc-card-h"><h3>📦 Invoice Lines vs Delivery</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">billed vs delivered, at PI prices</span></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Roshen / Code</th><th>Description</th><th class="num">Invoiced</th><th class="num">Expected</th><th class="num">Price/Case</th><th class="num">Taxable</th><th class="num">VAT</th><th>Match</th></tr></thead><tbody>${lineRows}</tbody></table></div></div>
    ${disputeCard}
    <div data-el="si-attachments"></div>
    ${auditCard}`);
  attachmentsPanel(root.querySelector('[data-el="si-attachments"]'), 'supplier_invoice', inv.id, { actor: ACTOR });

  wire(root, {
    back: () => ctx.navigate('supplier-invoices'),
    print: () => { if (!printSupplierInvoice(inv)) toast('Allow pop-ups to print', 'err'); },
    rematch: async () => { try { const r = await matchInvoiceLineLevel(invoiceId, { actor: ACTOR }); toast('Invoice ' + r.status, r.matched ? 'ok' : 'info'); renderInvoiceDetail(root, ctx, invoiceId); } catch (e) { toast(e.message || String(e), 'err'); } },
    dispute: async () => {
      try {
        const m = await matchInvoiceLineLevel(invoiceId, { actor: ACTOR, keepStatus: true });
        const r = await disputeInvoiceDifferences({ orderId: inv.order_id, invoiceId, deliveryNoteId: inv.delivery_note_id, lines: m.result.lines, createdBy: ACTOR });
        toast(r.disputes + ' dispute(s) raised', 'info'); renderInvoiceDetail(root, ctx, invoiceId);
      } catch (e) { toast(e.message || String(e), 'err'); }
    },
    closedispute: async ({ id }) => { try { await closeInvoiceDispute(Number(id), { resolvedBy: ACTOR }); toast('Dispute closed', 'ok'); renderInvoiceDetail(root, ctx, invoiceId); } catch (e) { toast(e.message || String(e), 'err'); } },
    edit: () => openEditModal(inv, () => renderInvoiceDetail(root, ctx, invoiceId)),
    credit: () => openNoteModal(inv, 'credit_note', () => renderInvoiceDetail(root, ctx, invoiceId)),
    debit: () => openNoteModal(inv, 'debit_note', () => renderInvoiceDetail(root, ctx, invoiceId)),
    cancel: () => openReasonModal('Cancel this document?', 'It will be excluded from the invoiced ledger. This is audited.', 'Cancel', async (reason) => {
      try { await cancelSupplierInvoice(invoiceId, { reason, actor: ACTOR }); toast('Cancelled', 'ok'); renderInvoiceDetail(root, ctx, invoiceId); } catch (e) { toast(e.message || String(e), 'err'); }
    }),
    viewdoc: async () => {
      try {
        const d = await getInvoiceDocument(invoiceId);
        if (!d || !d.data) return toast('No document attached', 'info');
        const bin = atob(d.data); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: d.mime || 'application/pdf' }));
        window.open(url, '_blank'); setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { toast(e.message || String(e), 'err'); }
    },
  });
}

// ---- helpers / modals ----------------------------------------------
const MATCH = { matched: 'confirmed', partial: 'pi', qty_variance: 'closed', price_variance: 'closed', tax_variance: 'closed', missing: 'draft', extra: 'closed', bound: 'none', unbound: 'draft' };
const MATCH_LABEL = { matched: 'Matched', partial: 'Partial', qty_variance: 'Qty diff', price_variance: 'Price diff', tax_variance: 'Tax diff', missing: 'Missing', extra: 'Extra', bound: 'Bound', unbound: 'Not matched' };
const matchChip = (m) => `<span class="sc-badge ${MATCH[m] || 'none'}">${esc(MATCH_LABEL[m] || m)}</span>`;
const DKIND = { qty_diff: 'Quantity', price_diff: 'Price', tax_diff: 'Tax', missing: 'Missing', extra: 'Extra' };
const disputeKind = (k) => `<span class="sc-badge closed">${esc(DKIND[k] || k)}</span>`;
const ACTION = { created: '➕ Created', edited: '✏️ Edited', matched: '🔗 Matched', disputed: '⚖ Disputed', cancelled: '✖ Cancelled', replaced: '↩ Replaced', credit_note: '➖ Credit note', debit_note: '➕ Debit note' };
const actionLabel = (a) => ACTION[a] || a;

function openReasonModal(title, body, confirmLabel, onConfirm) {
  modal(title, `${body}<div class="sc-field" style="margin-top:12px"><label>Reason (optional)</label><input id="si-reason" class="sc-input" placeholder="e.g. duplicate invoice"></div>`, [
    { label: confirmLabel, cls: 'primary', onClick: () => onConfirm((document.getElementById('si-reason') || {}).value || null) },
    { label: 'Back', cls: 'ghost' },
  ]);
}

function openEditModal(inv, onDone) {
  const rows = (inv.items || []).map((l) => `<tr>
    <td class="mono">${esc(l.roshen_id || l.item_code)}</td>
    <td><input class="sc-input sm num" data-l="${l.id}" data-f="invoiced_cases" type="number" step="1" value="${esc(String(l.invoiced_cases ?? 0))}" style="max-width:80px"></td>
    <td><input class="sc-input sm num" data-l="${l.id}" data-f="case_price" type="number" step="0.01" value="${esc(String(l.case_price ?? ''))}" style="max-width:90px"></td>
    <td><input class="sc-input sm num" data-l="${l.id}" data-f="taxable_amount" type="number" step="0.01" value="${esc(String(l.taxable_amount ?? ''))}" style="max-width:100px"></td>
    <td><input class="sc-input sm num" data-l="${l.id}" data-f="vat_amount" type="number" step="0.01" value="${esc(String(l.vat_amount ?? ''))}" style="max-width:90px"></td></tr>`).join('');
  modal(`Edit ${esc(inv.invoice_number)}`, `
    <div class="sc-form-grid">
      <div class="sc-field"><label>Invoice Number</label><input id="e-num" class="sc-input" value="${esc(inv.invoice_number || '')}"></div>
      <div class="sc-field"><label>Invoice Date</label><input id="e-date" class="sc-input" type="date" value="${esc(inv.invoice_date || '')}"></div>
      <div class="sc-field"><label>Supply Date</label><input id="e-supply" class="sc-input" type="date" value="${esc(inv.supply_date || '')}"></div>
      <div class="sc-field"><label>Supplier</label><input id="e-supplier" class="sc-input" value="${esc(inv.supplier || '')}"></div>
    </div>
    <div class="sc-table-wrap" style="margin-top:10px;max-height:260px;overflow:auto"><table class="sc-table"><thead><tr><th>Roshen</th><th class="num">Cases</th><th class="num">Price</th><th class="num">Taxable</th><th class="num">VAT</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">Saving re-runs the line-level match and is recorded in the audit trail. Blocked once goods are received.</p>`, [
    { label: 'Save changes', cls: 'primary', onClick: async () => {
        const val = (id) => (document.getElementById(id) || {}).value;
        const edits = {};
        qsa('[data-l]').forEach((n) => { const id = n.dataset.l, f = n.dataset.f; (edits[id] = edits[id] || {})[f] = n.value === '' ? null : Number(n.value); });
        const lines = (inv.items || []).map((l) => {
          const e = edits[l.id] || {};
          return { roshen_id: l.roshen_id, item_code: l.item_code, description: l.description, uom: l.uom,
            invoiced_cases: e.invoiced_cases != null ? e.invoiced_cases : l.invoiced_cases,
            case_price: e.case_price !== undefined ? e.case_price : l.case_price,
            taxable_amount: e.taxable_amount !== undefined ? e.taxable_amount : l.taxable_amount,
            vat_percent: l.vat_percent, vat_amount: e.vat_amount !== undefined ? e.vat_amount : l.vat_amount,
            line_total: null };
        });
        try {
          await editSupplierInvoice(inv.id, { header: { invoice_number: val('e-num') || inv.invoice_number, invoice_date: val('e-date') || null, supply_date: val('e-supply') || null, supplier: val('e-supplier') || null }, lines }, ACTOR);
          toast('Invoice updated', 'ok'); onDone();
        } catch (e) { toast('Edit failed: ' + (e.message || e), 'err'); }
      } },
    { label: 'Cancel', cls: 'ghost' },
  ]);
}

// Credit / debit note against the invoice. Enter POSITIVE cases per line; a
// credit note is stored as a reduction, a debit note as an increase.
function openNoteModal(inv, docType, onDone) {
  const label = DOC_LABEL[docType];
  const rows = (inv.items || []).map((l) => `<tr>
    <td class="mono">${esc(l.roshen_id || l.item_code)}</td><td>${esc((l.description || '').slice(0, 30))}</td>
    <td class="num">${qty(l.invoiced_cases)}</td>
    <td><input class="sc-input sm num" data-n="${l.id}" type="number" min="0" step="1" value="0" style="max-width:80px"></td></tr>`).join('');
  const byId = {}; (inv.items || []).forEach((l) => { byId[l.id] = l; });
  modal(`${label} against ${esc(inv.invoice_number)}`, `
    <p style="font-size:12px;color:var(--text-secondary);margin-top:0">Enter the cases to ${docType === 'credit_note' ? 'credit (reduce)' : 'add (debit)'} per line, at the invoiced price. The note nets automatically in the PO invoiced balance.</p>
    <div class="sc-form-grid">
      <div class="sc-field"><label>${label} Number</label><input id="n-num" class="sc-input" value="${docType === 'credit_note' ? 'CN-' : 'DN-'}${esc(inv.invoice_number || '')}"></div>
      <div class="sc-field"><label>Date</label><input id="n-date" class="sc-input" type="date"></div>
      <div class="sc-field" style="grid-column:1/-1"><label>Reason</label><input id="n-reason" class="sc-input" placeholder="e.g. 20 cases returned"></div>
    </div>
    <div class="sc-table-wrap" style="margin-top:10px;max-height:240px;overflow:auto"><table class="sc-table"><thead><tr><th>Roshen</th><th>Description</th><th class="num">Invoiced</th><th class="num">${docType === 'credit_note' ? 'Credit' : 'Debit'} cases</th></tr></thead><tbody>${rows}</tbody></table></div>`, [
    { label: 'Issue ' + label, cls: 'primary', onClick: async () => {
        const val = (id) => (document.getElementById(id) || {}).value;
        const sign = docType === 'credit_note' ? -1 : 1;
        const lines = [];
        qsa('[data-n]').forEach((nn) => {
          const cases = Number(nn.value || 0); if (!cases) return;
          const l = byId[nn.dataset.n]; const price = Number(l.case_price || 0);
          const taxable = +(sign * cases * price).toFixed(2);
          lines.push({ roshen_id: l.roshen_id, item_code: l.item_code, description: l.description, uom: l.uom,
            invoiced_cases: sign * cases, case_price: price, taxable_amount: taxable,
            vat_percent: 15, vat_amount: +(taxable * 0.15).toFixed(2), line_total: +(taxable * 1.15).toFixed(2) });
        });
        if (!lines.length) return toast('Enter at least one line quantity', 'err');
        try {
          await createAdjustmentNote(inv.id, { docType, header: { invoice_number: val('n-num'), invoice_date: val('n-date') || null, dn_reference: inv.dn_reference, supplier: inv.supplier, buyer: inv.buyer, zatca: inv.zatca }, lines, reason: val('n-reason') || null, actor: ACTOR });
          toast(label + ' issued', 'ok'); onDone();
        } catch (e) { toast('Failed: ' + (e.message || e), 'err'); }
      } },
    { label: 'Cancel', cls: 'ghost' },
  ]);
}
