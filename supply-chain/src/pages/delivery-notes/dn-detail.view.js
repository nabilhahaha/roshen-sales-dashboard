// Delivery Note detail — header + actions (print / edit / cancel / reverse),
// per-line delivered / remaining / disputed vs the PO, batches with live shelf
// life, the supplier-invoice match gate, goods-receipt creation, and the audit
// trail. Pages talk only to services.
import { mount, wire, qsa } from '../../utils/dom.js';
import { esc, qty, today, normRoshen } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { statusBadge, qcBadge, shelfChip } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import {
  getDeliveryNote, editDeliveryNote, cancelDeliveryNote, reverseDeliveryNote, listDnAudit,
  markDnInTransit, setExpectedDelivery,
} from '../../services/delivery-note/delivery-note.service.js';
import { getFulfillmentWithSummary } from '../../services/fulfillment/fulfillment.service.js';
import { receivingValidation } from '../../services/delivery-note/dn-receiving-validation.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';
import { matchInvoiceToDeliveryNote, getInvoiceDocument } from '../../services/supplier-invoice/supplier-invoice.service.js';
import { createGoodsReceiptFromDeliveryNote } from '../../services/goods-receiving/goods-receiving.service.js';
import { printDeliveryNote } from '../../utils/documents.js';
import { attachmentsPanel } from '../../components/attachments/attachments-panel.js';

const ACTOR = 'Development';

export async function renderDnDetail(root, ctx, dnId) {
  mount(root, loading('Loading delivery note…'));
  let dn, skus, byRoshen, byCode, ful, audit;
  try {
    [dn, skus] = await Promise.all([getDeliveryNote(dnId), listSkus()]);
    byRoshen = indexByRoshen(skus); byCode = indexByCode(skus);
    [ful, audit] = await Promise.all([
      getFulfillmentWithSummary(dn.order_id).catch(() => ({ rows: [] })),
      listDnAudit(dnId).catch(() => []),
    ]);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const skuFor = (l) => byRoshen[String(l.roshen_id || '').trim()] || byCode[String(l.item_code || '').trim()] || null;
  const fulByKey = {}; (ful.rows || []).forEach((r) => { fulByKey[normRoshen(r.roshen_id) || r.item_code] = r; });

  const inv = dn.invoice, gr = dn.goods_receipt;
  const invMatched = inv && inv.status === 'Matched';
  const grReleased = gr && ['Released', 'Partially Released'].includes(gr.status);
  const editable = !['Cancelled', 'Reversed'].includes(dn.status) && !grReleased;
  const reversible = grReleased || dn.status === 'Received';

  const lineRows = dn.items.map((it) => {
    const sku = skuFor(it);
    const total = (it.batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    const f = fulByKey[normRoshen(it.roshen_id) || it.item_code];
    const disputed = f ? Number(f.disputed_cases || 0) : 0;
    const remaining = f ? Number(f.remaining_cases != null ? f.remaining_cases : Math.max(0, Number(f.ordered_cases || 0) - Number(f.received_cases || 0))) : null;
    const head = `<tr class="sc-row-head">
      <td class="mono"><b>${esc(it.roshen_id || it.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(it.item_code || '')}</div></td>
      <td>${esc(it.description || '')}</td>
      <td class="num"><b>${qty(total)}</b></td>
      <td class="num">${f ? qty(remaining) : '—'}</td>
      <td class="num">${disputed > 0 ? `<span class="sc-badge closed">${qty(disputed)}</span>` : '—'}</td>
      <td>${it.match_status === 'additional' ? '<span class="sc-badge closed">Not on PI</span>' : '<span class="sc-badge confirmed">On PI</span>'}</td></tr>`;
    const batches = (it.batches || []).map((b) => {
      const sl = shelfLife(sku, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
      return `<tr>
        <td class="mono" style="padding-left:22px">${esc(b.batch_no || '—')}</td>
        <td>${esc(b.expiry_date || '—')} <span style="color:var(--text-muted);font-size:10.5px">${b.manufacturing_date ? 'mfg ' + esc(b.manufacturing_date) : ''}</span></td>
        <td class="num">${qty(b.cases)}</td><td class="num"></td><td>${shelfChip(sl)}</td><td>${qcBadge(b.qc_status)}</td></tr>`;
    }).join('');
    return head + batches;
  }).join('');

  const anyDisputed = (ful.summary && ful.summary.disputed > 0);

  // Receiving validation — one row per physical batch: shelf life vs the
  // SKU Master minimum, with the Accept / Approval Required / Reject decision.
  const rv = receivingValidation(dn, ful.rows || [], skuFor, today());
  const pctBar = (pct, color) => pct == null ? '<span style="color:var(--text-muted)">n/a</span>'
    : `<div style="display:flex;align-items:center;gap:7px;min-width:120px">
        <div style="flex:1;height:7px;border-radius:4px;background:var(--border-light);overflow:hidden">
          <div style="width:${Math.max(0, Math.min(100, pct))}%;height:100%;background:${color}"></div></div>
        <b style="font-size:11.5px;min-width:38px">${pct}%</b></div>`;
  const rvRows = rv.rows.map((r) => `<tr${r.decision.code === 'reject' ? ' style="background:rgba(224,49,49,.05)"' : ''}>
      <td class="mono"><b>${esc(r.roshen_id || r.sku_code || '')}</b><div style="font-size:10.5px;color:var(--text-muted)">${esc(r.sku_code || '')}</div></td>
      <td style="font-size:11.5px;max-width:220px">${esc((r.description || '').slice(0, 44))}</td>
      <td class="mono">${esc(r.batch_no || '—')}</td>
      <td style="font-size:11.5px">${r.manufacturing_date ? esc(r.manufacturing_date) : r.mfg_implied ? `<span title="No manufacturing date on the document — implied from the SKU's total shelf life">${esc(String(r.mfg_implied.toISOString ? r.mfg_implied.toISOString().slice(0, 10) : r.mfg_implied))}*</span>` : '—'}</td>
      <td style="font-size:11.5px">${esc(r.expiry_date || '—')}</td>
      <td class="num">${r.ordered_cases == null ? '—' : qty(r.ordered_cases)}</td>
      <td class="num">${qty(r.batch_cases)}<div style="font-size:10px;color:var(--text-muted)">${r.delivered_cases == null ? '' : 'line ' + qty(r.delivered_cases)}</div></td>
      <td class="num">${r.remaining_cases == null ? '—' : qty(r.remaining_cases)}</td>
      <td class="num">${r.remaining_days == null ? '—' : qty(r.remaining_days)}</td>
      <td>${pctBar(r.remaining_pct, r.decision.color)}</td>
      <td class="num">${r.required_pct == null ? '—' : r.required_pct + '%'}</td>
      <td style="white-space:nowrap"><span style="color:${r.decision.color};font-weight:700;font-size:11.5px">${r.decision.icon} ${esc(r.decision.label)}</span></td>
    </tr>`).join('');
  const validationCard = rv.rows.length ? `<div class="sc-card">
    <div class="sc-card-h"><h3>🧪 Receiving Validation — Shelf Life</h3><div class="sc-spacer"></div>
      <span style="font-size:12px;color:var(--text-secondary)">🟢 <b>${rv.summary.accept}</b> · 🟡 <b>${rv.summary.approval}</b> · 🔴 <b>${rv.summary.reject}</b> of ${rv.summary.batches} batch(es)</span></div>
    <p style="font-size:11.5px;color:var(--text-muted);margin:0 0 8px">Remaining % = (expiry − today) ÷ (expiry − manufacturing) · Required % comes from the SKU Master per item · * manufacturing date implied from the SKU's total shelf life. Batches below the required % need an approved exception at warehouse receiving.</p>
    ${tableWrap(`<table class="sc-table"><thead><tr>
      <th>SKU</th><th>Description</th><th>Batch</th><th>Mfg Date</th><th>Expiry Date</th>
      <th class="num">Ordered Qty</th><th class="num">Delivered Qty</th><th class="num">Remaining Qty</th>
      <th class="num">Remaining Days</th><th>Remaining Shelf Life %</th><th class="num">Required %</th><th>Status</th></tr></thead>
      <tbody>${rvRows}</tbody></table>`)}
  </div>` : '';

  let invoiceCard;
  if (!inv) {
    invoiceCard = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Supplier Invoice</h3></div>
      <p style="font-size:12.5px;color:var(--text-secondary)">Upload the supplier invoice for this delivery. It must match the delivery (items, quantities and prices) before the goods can be received.</p>
      <button class="sc-btn primary" data-act="upload" ${editable ? '' : 'disabled'}>📄 Upload Supplier Invoice (PDF)</button></div>`;
  } else {
    invoiceCard = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Supplier Invoice</h3><div class="sc-spacer"></div>${statusBadge(inv.status)}</div>
      <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:12.5px">
        <div>Invoice #: <b>${esc(inv.invoice_number)}</b></div><div>Date: <b>${esc(inv.invoice_date || '—')}</b></div>
        <div>Net: <b>${qty(inv.total_taxable)}</b></div><div>Grand: <b>${qty(inv.grand_total)}</b></div></div>
      ${dn.invoices && dn.invoices.length > 1 ? `<div style="font-size:11.5px;color:var(--text-muted);margin-top:6px">${dn.invoices.length} invoices/notes on this delivery — manage them in Supplier Invoices.</div>` : ''}
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:12px">
        <button class="sc-btn sm ghost" data-act="openinv" data-id="${inv.id}">🧾 Open in Supplier Invoices →</button>
        ${inv.document_path ? '<button class="sc-btn sm ghost" data-act="viewdoc">📎 View original PDF</button>' : ''}
        ${!invMatched ? '<button class="sc-btn sm ghost" data-act="rematch">🔗 Re-check match</button>' : ''}
        ${!grReleased ? '<button class="sc-btn sm ghost" data-act="reupload">↻ Add / replace invoice</button>' : ''}</div></div>`;
  }

  let grCard;
  if (gr) {
    grCard = `<div class="sc-card"><div class="sc-card-h"><h3>📦 Goods Receipt</h3><div class="sc-spacer"></div>${statusBadge(gr.status)}</div>
      <button class="sc-btn primary" data-act="opengr" data-id="${gr.id}">Open Goods Receipt →</button></div>`;
  } else {
    const eta = dn.expected_delivery_at ? String(dn.expected_delivery_at).slice(0, 16).replace('T', ' ') : null;
    const inTransit = dn.status === 'In Transit', ready = dn.status === 'Ready for Delivery';
    grCard = `<div class="sc-card"><div class="sc-card-h"><h3>🛫 Shipment &amp; Receiving</h3><div class="sc-spacer"></div>${(ready || inTransit) ? statusBadge(dn.status) : ''}</div>
      <p style="font-size:12.5px;color:var(--text-secondary)">${!invMatched
        ? 'Blocked: the supplier invoice must match this delivery note first (same items, quantities and prices).'
        : inTransit
          ? `On its way${eta ? ' — expected <b>' + esc(eta) + '</b>' : ''}. When it arrives, confirm the warehouse receipt.`
          : 'Invoice matched — the shipment is ready. Set the expected delivery date, then confirm the warehouse receipt when it arrives.'}</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${invMatched && !inTransit ? '<button class="sc-btn primary" data-act="dispatch">🚚 Dispatch — set Expected Delivery</button>' : ''}
        ${invMatched && inTransit ? '<button class="sc-btn sm ghost" data-act="dispatch">🕓 Update ETA</button>' : ''}
        <button class="sc-btn ${invMatched ? 'green' : 'ghost'}" data-act="creategr" ${invMatched ? '' : 'disabled'}>✅ Confirm Warehouse Receipt</button>
      </div></div>`;
  }

  const auditCard = `<div class="sc-card"><div class="sc-card-h"><h3>🕓 Audit Trail</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${audit.length}</span></div>
    ${audit.length ? `<div class="erp-rev-timeline">${audit.map((a) => `<div class="erp-rev">
      <div class="erp-rev-h"><b>${esc(actionLabel(a.action))}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc((a.actor || '—'))} · ${esc(String(a.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      ${a.note ? `<div style="font-size:12px;color:var(--text-secondary)">${esc(a.note)}</div>` : ''}
      ${a.action === 'edited' && a.detail ? editDiff(a.detail) : ''}</div>`).join('')}</div>`
      : '<p style="font-size:12px;color:var(--text-muted);margin:0">No actions recorded yet.</p>'}</div>`;

  const actionBtns = [
    '<button class="sc-btn sm ghost" data-act="print">🖨 Print DN</button>',
    editable ? '<button class="sc-btn sm ghost" data-act="edit">✏️ Edit</button>' : '',
    editable ? '<button class="sc-btn sm ghost" data-act="cancel">✖ Cancel</button>' : '',
    reversible ? '<button class="sc-btn sm ghost" data-act="reverse">↩ Reverse</button>' : '',
  ].filter(Boolean).join('');

  mount(root, `
    <div class="sc-card-h"><h3>🚚 ${esc(dn.dn_number)}</h3><div class="sc-spacer"></div>
      ${statusBadge(dn.status)}<span style="margin-left:8px">${actionBtns}</span>
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Delivery Notes</button></div>
    ${anyDisputed ? `<div class="sc-card" style="border-left:3px solid #F76707"><b>⚖ Over-delivery under dispute</b>
      <p style="font-size:12px;color:var(--text-secondary);margin:6px 0 0">This delivery exceeds the PI quantity by <b>${qty(ful.summary.disputed)}</b> case(s). The excess is marked as disputed and can never be received.</p></div>` : ''}
    <div class="sc-card"><div class="sc-form-grid">
      <div class="sc-field"><label>PI</label><input class="sc-input" readonly value="${esc((dn.order && dn.order.order_number) || '')}"></div>
      <div class="sc-field"><label>PI Reference (on document)</label><input class="sc-input" readonly value="${esc(dn.po_reference || '—')}"></div>
      <div class="sc-field"><label>DN Date</label><input class="sc-input" readonly value="${esc(dn.dn_date || '—')}"></div>
      <div class="sc-field"><label>Supplier</label><input class="sc-input" readonly value="${esc(dn.supplier || '—')}"></div>
      <div class="sc-field"><label>Total Cartons</label><input class="sc-input" readonly value="${esc(String(dn.total_cartons ?? '—'))}"></div>
      <div class="sc-field"><label>Warehouse</label><input class="sc-input" readonly value="${esc((dn.order && dn.order.warehouse) || '—')}"></div>
    </div>
    ${dn.document_type || dn.customer || dn.supplier_vat ? `<div style="display:flex;gap:20px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-light);font-size:11.5px;color:var(--text-secondary)">
      ${dn.document_type ? `<span>Document: <b>${esc(dn.document_type)}</b></span>` : ''}
      ${dn.supplier_vat ? `<span>Supplier VAT: <b class="mono">${esc(dn.supplier_vat)}</b></span>` : ''}
      ${dn.supplier_cr ? `<span>Supplier CR: <b class="mono">${esc(dn.supplier_cr)}</b></span>` : ''}
      ${dn.customer ? `<span>Customer: <b>${esc(dn.customer)}</b></span>` : ''}
      ${dn.customer_vat ? `<span>Customer VAT: <b class="mono">${esc(dn.customer_vat)}</b></span>` : ''}
      ${dn.supplier_bank ? `<span>Bank: <b>${esc(dn.supplier_bank)}</b>${dn.supplier_iban ? ` · <span class="mono">${esc(dn.supplier_iban)}</span>` : ''}</span>` : ''}
      ${dn.received_by ? `<span>Received by: <b>${esc(dn.received_by)}</b></span>` : ''}
    </div>` : ''}</div>
    <div class="erp-grid-2">${invoiceCard}${grCard}</div>
    <div class="sc-card"><div class="sc-card-h"><h3>🔗 Related Documents</h3></div>
      <div class="sc-table-wrap"><table class="sc-table"><tbody>
        ${dn.order ? `<tr class="sc-row-link" data-act="openpi"><td>📄 Purchase Invoice (PI)</td><td class="mono"><b>${esc(dn.order.order_number)}</b></td><td>${statusBadge(dn.order.status)}</td><td style="text-align:right;color:var(--text-muted)">→</td></tr>` : ''}
        ${(dn.invoices || []).map((i) => `<tr class="sc-row-link" data-act="openinv" data-id="${i.id}"><td>🧾 Supplier Invoice</td><td class="mono"><b>${esc(i.invoice_number)}</b></td><td>${statusBadge(i.status)}</td><td style="text-align:right;color:var(--text-muted)">→</td></tr>`).join('')}
        ${gr ? `<tr class="sc-row-link" data-act="opengr" data-id="${gr.id}"><td>📦 Warehouse Receipt</td><td class="mono"><b>${esc(gr.grn_number || ('#' + gr.id))}</b></td><td>${statusBadge(gr.status)}</td><td style="text-align:right;color:var(--text-muted)">→</td></tr>` : ''}
      </tbody></table></div></div>
    ${validationCard}
    <div class="sc-card"><div class="sc-card-h"><h3>📦 Lines &amp; Batches</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">delivered · remaining · disputed vs the PI · shelf life is live</span></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Batch / Lot · Item</th><th>Expiry</th><th class="num">Delivered</th><th class="num">Remaining</th><th class="num">Disputed / Shelf</th><th>QC</th></tr></thead><tbody>${lineRows}</tbody></table></div></div>
    <div data-el="dn-attachments"></div>
    ${auditCard}`);
  attachmentsPanel(root.querySelector('[data-el="dn-attachments"]'), 'delivery_note', dn.id, { actor: ACTOR });

  wire(root, {
    back: () => ctx.navigate('delivery-notes'),
    print: () => { if (!printDeliveryNote(dn)) toast('Allow pop-ups to print', 'err'); },
    edit: () => openEditModal(dn, () => renderDnDetail(root, ctx, dnId)),
    cancel: () => openReasonModal('Cancel delivery note?', 'The delivery will be removed from the PI totals. This action is recorded.', 'Cancel DN', async (reason) => {
      try { await cancelDeliveryNote(dnId, { reason, actor: ACTOR }); toast('Delivery note cancelled', 'ok'); renderDnDetail(root, ctx, dnId); } catch (e) { toast(e.message || String(e), 'err'); }
    }),
    reverse: () => openReasonModal('Reverse delivery note?', 'The received quantities will be taken back out of the warehouse and the PI totals updated. This action is recorded.', 'Reverse DN', async (reason) => {
      try { await reverseDeliveryNote(dnId, { reason, actor: ACTOR }); toast('Delivery note reversed · inventory adjusted', 'ok'); renderDnDetail(root, ctx, dnId); } catch (e) { toast(e.message || String(e), 'err'); }
    }),
    upload: () => ctx.navigate('delivery-notes', { view: 'invoice', dnId }),
    reupload: () => ctx.navigate('delivery-notes', { view: 'invoice', dnId }),
    viewdoc: async () => {
      try {
        const doc = await getInvoiceDocument(inv.id);
        if (!doc || !doc.data) return toast('No document attached', 'info');
        const bin = atob(doc.data); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const url = URL.createObjectURL(new Blob([bytes], { type: doc.mime || 'application/pdf' }));
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      } catch (e) { toast(e.message || String(e), 'err'); }
    },
    rematch: async () => { try { const r = await matchInvoiceToDeliveryNote(inv.id); toast('Invoice ' + r.status, r.matched ? 'ok' : 'info'); renderDnDetail(root, ctx, dnId); } catch (e) { toast(e.message || String(e), 'err'); } },
    creategr: async () => {
      try { const g = await createGoodsReceiptFromDeliveryNote(dn.id, { warehouse: dn.order && dn.order.warehouse, createdBy: 'dn-detail' }); toast('Goods receipt ' + g.grn_number + ' created', 'ok'); ctx.navigate('goods-receiving', { view: 'detail', grId: g.id }); }
      catch (e) { toast(e.message || String(e), 'err'); }
    },
    opengr: ({ id }) => ctx.navigate('goods-receiving', { view: 'detail', grId: id }),
    openpi: () => ctx.navigate('purchase-orders', { orderId: dn.order_id, mode: 'view' }),
    openinv: ({ id }) => ctx.navigate('supplier-invoices', { view: 'detail', invoiceId: id }),
    dispatch: () => {
      const cur = dn.expected_delivery_at ? String(dn.expected_delivery_at).slice(0, 16) : '';
      modal('🛫 Dispatch shipment', `
        <p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">Set the expected delivery date &amp; time. The shipment becomes <b>In Transit</b> — it is not inventory until the arrival is confirmed.</p>
        <div class="sc-field"><label>Expected delivery (date &amp; time)</label><input id="dn-eta" class="sc-input" type="datetime-local" value="${esc(cur)}"></div>`, [
        { label: dn.status === 'In Transit' ? 'Update ETA' : 'Dispatch', cls: 'primary', onClick: async () => {
            const v = (document.getElementById('dn-eta') || {}).value || null;
            try {
              if (dn.status === 'In Transit') { await setExpectedDelivery(dnId, v, { actor: ACTOR }); toast('ETA updated', 'ok'); }
              else { await markDnInTransit(dnId, { expectedAt: v, actor: ACTOR }); toast('Shipment in transit', 'ok'); }
              renderDnDetail(root, ctx, dnId);
            } catch (e) { toast(e.message || String(e), 'err'); }
          } },
        { label: 'Back', cls: 'ghost' },
      ]);
    },
  });
}

const ACTION = { created: '➕ Created', edited: '✏️ Edited', cancelled: '✖ Cancelled', reversed: '↩ Reversed', received: '📦 Received', status_change: '↔ Status changed' };
function actionLabel(a) { return ACTION[a] || a; }
function editDiff(detail) {
  const b = detail.before, a = detail.after;
  if (!b || !a) return '';
  const sum = (s) => (s.lines || []).reduce((x, l) => x + Number(l.cases || 0), 0);
  return `<div style="font-size:11.5px;color:var(--text-muted);margin-top:4px">cartons ${qty(sum(b))} → ${qty(sum(a))}</div>`;
}

function openReasonModal(title, body, confirmLabel, onConfirm) {
  modal(title, `${body}<div class="sc-field" style="margin-top:12px"><label>Reason (optional)</label><input id="dn-reason" class="sc-input" placeholder="e.g. wrong items shipped"></div>`, [
    { label: confirmLabel, cls: 'primary', onClick: () => onConfirm((document.getElementById('dn-reason') || {}).value || null) },
    { label: 'Back', cls: 'ghost' },
  ]);
}

// Edit modal: header fields + per-batch case quantities (keeps batch structure).
function openEditModal(dn, onDone) {
  const rows = dn.items.flatMap((it) => (it.batches || []).map((b) => `<tr>
    <td class="mono">${esc(it.roshen_id || it.item_code)}</td>
    <td class="mono">${esc(b.batch_no || '—')}</td><td>${esc(b.expiry_date || '—')}</td>
    <td><input class="sc-input sm num" data-batch="${b.id}" type="number" min="0" step="1" value="${esc(String(b.cases ?? 0))}" style="max-width:90px"></td></tr>`)).join('');
  modal(`Edit ${dn.dn_number}`, `
    <div class="sc-form-grid">
      <div class="sc-field"><label>DN Date</label><input id="e-date" class="sc-input" type="date" value="${esc(dn.dn_date || '')}"></div>
      <div class="sc-field"><label>Supplier</label><input id="e-supplier" class="sc-input" value="${esc(dn.supplier || '')}"></div>
      <div class="sc-field"><label>PO Reference</label><input id="e-poref" class="sc-input" value="${esc(dn.po_reference || '')}"></div>
      <div class="sc-field"><label>Notes</label><input id="e-notes" class="sc-input" value="${esc(dn.notes || '')}"></div>
    </div>
    <div class="sc-table-wrap" style="margin-top:10px;max-height:260px;overflow:auto"><table class="sc-table"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th class="num">Cases</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">Editing is recorded in the audit trail. Only allowed before goods are received.</p>`, [
    { label: 'Save changes', cls: 'primary', onClick: async () => {
        const val = (id) => (document.getElementById(id) || {}).value;
        const edited = {};
        qsa('[data-batch]').forEach((n) => { edited[n.dataset.batch] = Number(n.value || 0); });
        const lines = dn.items.map((it) => ({
          roshen_id: it.roshen_id, item_code: it.item_code, description: it.description, uom: it.uom, kind: it.match_status,
          batches: (it.batches || []).map((b) => ({ batch_no: b.batch_no, manufacturing_date: b.manufacturing_date, expiry_date: b.expiry_date, cases: edited[b.id] != null ? edited[b.id] : b.cases, boxes: b.boxes, pieces: b.pieces })),
        }));
        try {
          await editDeliveryNote(dn.id, { header: { dn_date: val('e-date') || null, supplier: val('e-supplier') || null, po_reference: val('e-poref') || null, notes: val('e-notes') || null }, lines }, ACTOR);
          toast('Delivery note updated', 'ok'); onDone();
        } catch (e) { toast('Edit failed: ' + (e.message || e), 'err'); }
      } },
    { label: 'Cancel', cls: 'ghost' },
  ]);
}
