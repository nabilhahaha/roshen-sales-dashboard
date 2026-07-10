// Purchase Orders — create / edit / view a purchase order.
// UI only; all persistence goes through the orders service.
import { mount, delegate, qs } from '../../utils/dom.js';
import { esc, money, qty, today } from '../../utils/format.js';
import { orderBadge, piBadge, tableWrap, loading } from '../../components/table/table.js';
import { field, createSkuCombo } from '../../components/forms/forms.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { one } from '../../services/supabase/client.js';
import { listSkus, indexByCode } from '../../services/sku/sku.service.js';
import * as Orders from '../../services/purchase-orders/orders.service.js';
import { getReceivingDashboard } from '../../services/fulfillment/fulfillment.service.js';
import { statusBadge } from '../../components/table/badges.js';
import { attachmentsPanel } from '../../components/attachments/attachments-panel.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';
import { listInvoices } from '../../services/supplier-invoice/supplier-invoice.service.js';
import { printOrder, exportOrderExcel } from '../../utils/documents.js';
import { ORDER_STATUS } from '../../models/order-status.js';
import { canCloseManually, CLOSE_REASONS } from '../../models/business-status.js';
import { renderOrdersList } from './orders-list.view.js';
import { listRevisions } from '../../services/purchase-orders/revision.service.js';
import { renderDocumentChain } from '../../components/related/document-chain.js';
import { renderDocumentShell, openDrawer, closeDrawer } from '../../components/document/document-shell.js';
import { renderDocumentsTab, renderTimelineTab, openBusinessFile } from '../../components/document/document-extras.js';
import { buildBusinessTimeline } from '../../services/timeline/business-timeline.service.js';
import { exportOrderBusinessFile } from '../../services/export/business-export.service.js';

let SKUS = [], SKU_BY_CODE = {};
const ED = { id: null, readonly: false, header: null, lines: [], pi: null, doc: null };
let ROOT = null, CTX = null;

// Document line fields imported from the supplier PI Excel — carried through
// edits so saving a Draft never loses what the document said.
const DOC_LINE_FIELDS = ['line_no', 'supplier_item_code', 'uom', 'units_qty', 'unit_price', 'discount_percent', 'net_unit_price', 'taxable_amount', 'vat_percent', 'vat_amount', 'amount'];
const lineFromDb = (it) => {
  const l = { item_code: it.item_code, roshen_id: it.roshen_id, item_description: it.item_description, price_case: Number(it.price_case), ordered_cases: Number(it.ordered_cases) };
  DOC_LINE_FIELDS.forEach((f) => { l[f] = it[f] ?? null; });
  return l;
};

export async function render(root, ctx) {
  ROOT = root; CTX = ctx;
  const p = ctx.params || {};
  // The module opens as the active-orders LIST (the workflow's starting
  // point); the editor is reached explicitly (view/edit/duplicate/new).
  if (!p.orderId && !p.duplicateFrom && p.mode !== 'new') return renderOrdersList(root, ctx, 'active');
  if (!SKUS.length) { try { SKUS = await listSkus(); SKU_BY_CODE = indexByCode(SKUS); } catch (e) { /* combobox will be empty */ } }
  delegate(root, ACTIONS);
  if (p.orderId) await openOrder(p.orderId, p.mode || 'view');
  else if (p.duplicateFrom) await duplicateOrder(p.duplicateFrom);
  else startNew();
}

function startNew() {
  ED.id = null; ED.readonly = false; ED.pi = null; ED.doc = null;
  ED.header = { order_number: '', order_date: today(), supplier: 'Roshen', warehouse: '', expected_arrival: '', notes: '', status: ORDER_STATUS.DRAFT };
  ED.lines = [];
  paint();
}
async function openOrder(id, mode) {
  mount(ROOT, loading());
  let data; try { data = await Orders.getOrder(id); } catch (e) { toast('Load failed: ' + e.message, 'err'); return; }
  ED.id = data.id; ED.pi = one(data.proforma_invoices); ED.doc = data;
  // replacement-PO links (both directions) for the closed-order card
  try {
    if (data.replaced_by_order_id) {
      const { data: r } = await (await import('../../services/supabase/client.js')).getClient()
        .from('supply_orders').select('id,order_number').eq('id', data.replaced_by_order_id).single();
      ED.doc.replaced_by = r || null;
    } else ED.doc.replaced_by = null;
    const { data: repl } = await (await import('../../services/supabase/client.js')).getClient()
      .from('supply_orders').select('id,order_number').eq('replaced_by_order_id', data.id);
    ED.doc.replaces = repl || [];
  } catch (e) { ED.doc.replaced_by = null; ED.doc.replaces = []; }
  ED.readonly = mode === 'view' || data.status !== ORDER_STATUS.DRAFT;
  ED.header = { order_number: data.order_number, order_date: data.order_date, supplier: data.supplier, warehouse: data.warehouse || '', expected_arrival: data.expected_arrival || '', notes: data.notes || '', status: data.status };
  ED.lines = (data.supply_order_items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0) || a.id - b.id).map(lineFromDb);
  paint();
}
async function duplicateOrder(id) {
  mount(ROOT, loading());
  let data; try { data = await Orders.getOrder(id); } catch (e) { toast('Load failed: ' + e.message, 'err'); return; }
  ED.id = null; ED.readonly = false; ED.pi = null; ED.doc = null;
  ED.header = { order_number: '', order_date: today(), supplier: data.supplier, warehouse: data.warehouse || '', expected_arrival: '', notes: data.notes || '', status: ORDER_STATUS.DRAFT };
  ED.lines = (data.supply_order_items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0) || a.id - b.id)
    .map((it) => ({ item_code: it.item_code, roshen_id: it.roshen_id, item_description: it.item_description, price_case: Number(it.price_case), ordered_cases: Number(it.ordered_cases) }));
  paint();
  toast('Duplicated — review and save as a new draft', 'info');
}

function pseudoOrder() {
  return { order_number: ED.header.order_number, order_date: ED.header.order_date, supplier: ED.header.supplier, warehouse: ED.header.warehouse, expected_arrival: ED.header.expected_arrival, status: ED.header.status, supply_order_items: ED.lines };
}

function paint() {
  const h = ED.header, ro = ED.readonly, isNew = ED.id == null, dis = ro ? 'disabled' : '';
  // V2: saved documents use the tabbed document shell; drafts keep the editor
  if (ro && !isNew) return paintDocumentView();
  let banner = '';
  if (ro && h.status !== ORDER_STATUS.DRAFT)
    banner = `<div class="sc-locked-banner">🔒 This PI is <b>&nbsp;${esc(h.status)}&nbsp;</b> and locked.</div>`;
  else if (ro)
    banner = `<div class="sc-locked-banner" style="background:rgba(143,163,189,.12);border-color:var(--border);color:var(--text-secondary)">👁 View mode <button class="sc-btn sm" style="margin-left:6px" data-act="unlock">✏️ Edit</button></div>`;

  // manually closed order — the close record (business action, fully audited)
  let closedCard = '';
  const dd = ED.doc;
  if (dd && dd.close_reason && ['Closed', 'Financially Closed'].includes(dd.status)) {
    closedCard = `<div class="sc-card" style="border-left:3px solid #E03131">
      <div class="sc-card-h"><h3>✖ Purchase Order Closed</h3><div class="sc-spacer"></div>
        <span style="font-size:11.5px;color:var(--text-muted)">${esc(String(dd.closed_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:12.5px">
        <div><span class="erp-mini">Close Reason</span><br><b>${esc(dd.close_reason)}</b></div>
        <div><span class="erp-mini">Closed By</span><br><b>${esc(dd.closed_by || '—')}</b></div>
        ${dd.close_comments ? `<div style="max-width:420px"><span class="erp-mini">Comments</span><br>${esc(dd.close_comments)}</div>` : ''}
        ${dd.replaced_by ? `<div><span class="erp-mini">Replaced By</span><br><button class="sc-btn sm" data-act="goorder" data-id="${dd.replaced_by.id}">→ ${esc(dd.replaced_by.order_number)}</button></div>` : ''}
      </div>
      <p style="font-size:11.5px;color:var(--text-secondary);margin:10px 0 0">Undelivered quantities are <b>Cancelled</b>. No new delivery notes or supplier invoices can be created against this order. All history is preserved.</p>
    </div>`;
  }
  const replacesChips = dd && dd.replaces && dd.replaces.length
    ? `<div class="sc-card" style="padding:10px 16px;font-size:12.5px">↩ This order replaces:
        ${dd.replaces.map((r) => `<button class="sc-btn sm ghost" data-act="goorder" data-id="${r.id}">${esc(r.order_number)}</button>`).join(' ')}</div>` : '';

  // Supplier document header — the PI as the business document reads
  // (supplier / customer / document details / totals), present whenever this
  // PI was imported from a supplier document.
  let docCard = '';
  const d = ED.doc;
  if (d && (d.document_type || d.supplier_vat || d.customer_name || d.total_gross != null)) {
    const cur = d.currency || 'SAR';
    const kvd = (l, v) => (v == null || v === '' ? '' : `<div style="min-width:145px"><span class="erp-mini">${l}</span><br><b style="font-size:12.5px">${esc(String(v))}</b></div>`);
    docCard = `<div class="sc-card">
      <div class="sc-card-h"><h3>🧾 ${esc(d.document_type || 'Supplier Document')} ${esc(d.order_number || '')}</h3><div class="sc-spacer"></div>
        ${d.source_filename ? `<span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(d.source_filename)}</span>` : ''}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px">
        <div>
          <div class="erp-mini" style="margin-bottom:6px">Supplier</div>
          <div style="display:flex;gap:18px;flex-wrap:wrap">${kvd('Company', d.supplier)}${kvd('VAT No.', d.supplier_vat)}${kvd('CR Number', d.supplier_cr)}
            ${kvd('Short Address', d.supplier_short_address)}${kvd('Bank', d.supplier_bank)}${kvd('IBAN', d.supplier_iban)}</div>
          ${d.supplier_address ? `<div style="margin-top:6px;font-size:11.5px;color:var(--text-secondary)">${esc(d.supplier_address)}</div>` : ''}
        </div>
        <div>
          <div class="erp-mini" style="margin-bottom:6px">Customer &amp; Document</div>
          <div style="display:flex;gap:18px;flex-wrap:wrap">${kvd('Customer', d.customer_name)}${kvd('Customer VAT №', d.customer_vat)}${kvd('Customer CR', d.customer_cr)}
            ${kvd('Document Date', d.order_date)}${kvd('Currency', d.currency)}${kvd('Salesman', d.salesman)}
            ${kvd('Payment Terms', d.payment_terms)}${kvd('Delivery Terms', d.delivery_terms)}</div>
        </div>
      </div>
      ${d.total_gross != null || d.total_net != null ? `<div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border-light)">
        ${kvd('Total Units', d.total_units == null ? null : qty(d.total_units))}
        ${kvd('Total Net (' + cur + ')', d.total_net == null ? null : money(d.total_net))}
        ${kvd('Total VAT (' + cur + ')', d.total_vat == null ? null : money(d.total_vat))}
        ${kvd('Grand Total (' + cur + ')', d.total_gross == null ? null : money(d.total_gross))}
        ${kvd('Gross Weight (kg)', d.gross_weight_kg == null ? null : qty(d.gross_weight_kg))}</div>` : ''}
    </div>`;
  }

  let piStrip = '';
  if (ED.pi) piStrip = `<div class="sc-card" style="padding:12px 16px"><div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;font-size:12.5px">
    <div><span class="erp-mini">PI Number</span><br><b>${esc(ED.pi.pi_number || '—')}</b></div>
    <div><span class="erp-mini">PI Date</span><br><b>${esc(ED.pi.pi_date || '—')}</b></div>
    <div><span class="erp-mini">PI Status</span><br>${piBadge(ED.pi.status)}</div>
    <div><span class="erp-mini">Import Date</span><br><b>${esc((ED.pi.imported_at || '').slice(0, 10) || '—')}</b></div>
    <button class="sc-btn sm" style="margin-left:auto" data-act="openPI">🧾 Open Validation Report</button></div></div>`;

  mount(ROOT, `
    <div class="sc-card-h"><h3>${isNew ? '➕ New Purchase Invoice (PI)' : '📄 Purchase Invoice (PI) ' + esc(h.order_number)}</h3>
      <div class="sc-spacer"></div>${orderBadge(ED.doc || h.status)}
      <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← All PIs</button></div>
    ${banner}
    ${closedCard}
    ${replacesChips}
    <div class="sc-card"><div class="sc-form-grid">
      ${field('Order Number', `<input class="sc-input" readonly value="${esc(isNew ? '(auto-generated on save)' : h.order_number)}">`)}
      ${field('Order Date', `<input data-el="order_date" type="date" class="sc-input" ${dis} value="${esc(h.order_date || '')}">`)}
      ${field('Supplier', `<input data-el="supplier" class="sc-input" ${dis} value="${esc(h.supplier || 'Roshen')}">`)}
      ${field('Warehouse', `<input data-el="warehouse" class="sc-input" ${dis} placeholder="e.g. Jeddah DC" value="${esc(h.warehouse || '')}">`)}
      ${field('Expected Arrival', `<input data-el="expected_arrival" type="date" class="sc-input" ${dis} value="${esc(h.expected_arrival || '')}">`)}
      ${field('Notes', `<input data-el="notes" class="sc-input" ${dis} placeholder="Optional" value="${esc(h.notes || '')}">`)}
    </div></div>
    ${docCard}
    ${piStrip}
    <div class="sc-card">
      <div class="sc-card-h"><h3>📦 Items</h3><div class="sc-spacer"></div>${ro ? '' : '<div data-el="combo" style="min-width:340px"></div>'}</div>
      <div data-el="lines"></div>
      <div class="sc-summary" data-el="summary"></div>
    </div>
    <div data-el="receiving"></div>
    <div data-el="attachments"></div>
    <div data-el="related"></div>
    <div data-el="timeline"></div>
    <div data-el="audit"></div>
    <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center" data-el="actions"></div>`);

  if (!ro) createSkuCombo(qs('[data-el="combo"]', ROOT), SKUS, addItem);
  renderLines();
  renderActions();
  if (!isNew && h.status !== ORDER_STATUS.DRAFT) renderReceivingProgress();
  if (!isNew) attachmentsPanel(qs('[data-el="attachments"]', ROOT), 'purchase_order', ED.id, { actor: 'Development' });
  if (!isNew) renderRelatedDocs();
  if (!isNew) renderTimeline();
  if (!isNew) renderAuditTrail();
}

// ---- V2 tabbed document view (readonly PIs) --------------------------------
// Standard shell: header (number · supplier · status · date · amount · last
// update) + tabs (Overview / Items / Delivery / Invoices / Documents /
// Timeline) + always-visible quick actions. All data comes from the same
// services as before — layout only.
let SHELL = null;
function paintDocumentView() {
  const h = ED.header, d = ED.doc || {};
  const cur = d.currency || 'SAR';
  const totalAmount = d.total_gross != null ? money(d.total_gross) + ' ' + cur
    : money(ED.lines.reduce((a, l) => a + (Number(l.price_case) || 0) * (Number(l.ordered_cases) || 0), 0)) + ' SAR';

  // manually closed order — the close record (shown above the tabs)
  let banner = '';
  if (d.close_reason && ['Closed', 'Financially Closed'].includes(d.status)) {
    banner = `<div class="sc-card" style="border-left:3px solid #E03131">
      <div class="sc-card-h"><h3>✖ Purchase Order Closed</h3><div class="sc-spacer"></div>
        <span style="font-size:11.5px;color:var(--text-muted)">${esc(String(d.closed_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:12.5px">
        <div><span class="erp-mini">Close Reason</span><br><b>${esc(d.close_reason)}</b></div>
        <div><span class="erp-mini">Closed By</span><br><b>${esc(d.closed_by || '—')}</b></div>
        ${d.close_comments ? `<div style="max-width:420px"><span class="erp-mini">Comments</span><br>${esc(d.close_comments)}</div>` : ''}
        ${d.replaced_by ? `<div><span class="erp-mini">Replaced By</span><br><button class="sc-btn sm" data-act="goorder" data-id="${d.replaced_by.id}">→ ${esc(d.replaced_by.order_number)}</button></div>` : ''}
      </div>
      <p style="font-size:11.5px;color:var(--text-secondary);margin:10px 0 0">Undelivered quantities are <b>Cancelled</b>. No new delivery notes or supplier invoices can be created against this order. All history is preserved.</p></div>`;
  }
  if (d.replaces && d.replaces.length) {
    banner += `<div class="sc-card" style="padding:10px 16px;font-size:12.5px">↩ This order replaces:
      ${d.replaces.map((r) => `<button class="sc-btn sm ghost" data-act="goorder" data-id="${r.id}">${esc(r.order_number)}</button>`).join(' ')}</div>`;
  }

  SHELL = renderDocumentShell(ROOT, {
    icon: '📄', title: 'Purchase Invoice (PI) ' + h.order_number,
    badges: orderBadge(ED.doc || h.status),
    headRight: '<button class="sc-btn sm ghost" data-act="back">← All PIs</button>',
    meta: [
      { label: 'Supplier', value: h.supplier },
      { label: 'Order Date', value: h.order_date },
      { label: 'Expected Arrival', value: h.expected_arrival || '—' },
      { label: 'Warehouse', value: h.warehouse || '—' },
      { label: 'Total Amount', value: totalAmount },
      { label: 'Business Status', value: orderBadge(ED.doc || h.status), html: true },
      { label: 'Last Update', value: String(d.updated_at || '').slice(0, 16).replace('T', ' ') || '—' },
    ],
    banner,
    activeTab: (CTX.params && CTX.params.tab),
    tabs: [
      { id: 'overview', label: 'Overview', icon: '📋', render: renderOverviewTab },
      { id: 'items', label: 'Items', icon: '📦', count: ED.lines.length, render: renderItemsTab },
      { id: 'delivery', label: 'Delivery', icon: '🚚', render: renderDeliveryTab },
      { id: 'invoices', label: 'Supplier Invoices', icon: '🧾', render: renderInvoicesTab },
      { id: 'documents', label: 'Documents', icon: '📎', render: (el) => renderDocumentsTab(el, { docType: 'purchase_order', docId: ED.id, orderId: ED.id, actor: 'Development' }) },
      { id: 'timeline', label: 'Timeline', icon: '🧭', render: renderPoTimelineTab },
    ],
    actions: [
      { act: 'bizfile', label: '📊 Export Excel', primary: true },
      { act: 'bizview', label: '📁 Business File' },
      { act: 'print', label: '🖨 Print' },
      { act: 'related', label: '🔗 Related Documents' },
      { act: 'gototimeline', label: '🧭 Timeline' },
      ED.pi ? { act: 'openPI', label: '🧾 PI Validation' } : (h.status === ORDER_STATUS.APPROVED ? { act: 'import', label: '📥 Import PI' } : null),
      { act: 'dup', label: '⧉ Duplicate' },
      canCloseManually({ status: h.status }) ? { act: 'close', label: '✖ Close Order', danger: true } : null,
      { act: 'refresh', label: '↻ Refresh' },
    ],
    onAction: (act, btn) => {
      if (act === 'gototimeline') return SHELL.show('timeline');
      if (act === 'bizview') return openBusinessFile(ED.id, (s, p) => CTX.navigate(s, p));
      if (act === 'related') {
        const body = openDrawer('🔗 Related Documents — ' + h.order_number, '');
        renderDocumentChain(body, (s, p) => { closeDrawer(); CTX.navigate(s, p); }, { orderId: ED.id, current: { type: 'purchase_order', id: ED.id } });
        return;
      }
      if (act === 'refresh') return openOrder(ED.id, 'view');
      const fn = ACTIONS[act]; if (fn) fn({}, btn);
    },
  });

  // ---- tab renderers (same services as before — layout only) ----
  async function renderOverviewTab(el) {
    const kvd = (l, v) => (v == null || v === '' ? '' : `<div style="min-width:145px"><span class="erp-mini">${l}</span><br><b style="font-size:12.5px">${esc(String(v))}</b></div>`);
    let kpis = '';
    try {
      const dash = await getReceivingDashboard(ED.id);
      const s = dash.summary || { ordered: 0, received: 0, remaining: 0 };
      const pct = s.ordered > 0 ? Math.min(100, Math.round((s.received / s.ordered) * 100)) : 0;
      kpis = `<div class="erp-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
        <div class="erp-kpi"><div class="k-lbl">Ordered</div><div class="k-val">${qty(s.ordered)}</div></div>
        <div class="erp-kpi"><div class="k-lbl">Received</div><div class="k-val" style="color:#2FB344">${qty(s.received)}</div></div>
        <div class="erp-kpi"><div class="k-lbl">Remaining</div><div class="k-val">${qty(s.remaining)}</div></div>
        <div class="erp-kpi"><div class="k-lbl">Progress</div><div class="k-val">${pct}%</div></div>
        <div class="erp-kpi"><div class="k-lbl">Status</div><div class="k-val" style="font-size:16px">${orderBadge(ED.doc || h.status)}</div></div>
      </div>`;
    } catch (e) { /* KPI row optional */ }
    let docCard = '';
    if (d.document_type || d.supplier_vat || d.customer_name || d.total_gross != null) {
      docCard = `<div class="sc-card">
        <div class="sc-card-h"><h3>🧾 ${esc(d.document_type || 'Supplier Document')} ${esc(d.order_number || '')}</h3><div class="sc-spacer"></div>
          ${d.source_filename ? `<span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(d.source_filename)}</span>` : ''}</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px">
          <div><div class="erp-mini" style="margin-bottom:6px">Supplier</div>
            <div style="display:flex;gap:18px;flex-wrap:wrap">${kvd('Company', d.supplier)}${kvd('VAT No.', d.supplier_vat)}${kvd('CR Number', d.supplier_cr)}
              ${kvd('Short Address', d.supplier_short_address)}${kvd('Bank', d.supplier_bank)}${kvd('IBAN', d.supplier_iban)}</div></div>
          <div><div class="erp-mini" style="margin-bottom:6px">Customer &amp; Document</div>
            <div style="display:flex;gap:18px;flex-wrap:wrap">${kvd('Customer', d.customer_name)}${kvd('Customer VAT №', d.customer_vat)}
              ${kvd('Document Date', d.order_date)}${kvd('Currency', d.currency)}${kvd('Salesman', d.salesman)}
              ${kvd('Payment Terms', d.payment_terms)}</div></div>
        </div>
        ${d.total_gross != null || d.total_net != null ? `<div style="display:flex;gap:22px;flex-wrap:wrap;margin-top:12px;padding-top:10px;border-top:1px solid var(--border-light)">
          ${kvd('Total Units', d.total_units == null ? null : qty(d.total_units))}
          ${kvd('Total Net (' + cur + ')', d.total_net == null ? null : money(d.total_net))}
          ${kvd('Total VAT (' + cur + ')', d.total_vat == null ? null : money(d.total_vat))}
          ${kvd('Grand Total (' + cur + ')', d.total_gross == null ? null : money(d.total_gross))}</div>` : ''}
      </div>`;
    }
    const piStrip = ED.pi ? `<div class="sc-card" style="padding:12px 16px"><div style="display:flex;gap:20px;flex-wrap:wrap;align-items:center;font-size:12.5px">
      <div><span class="erp-mini">PI Number</span><br><b>${esc(ED.pi.pi_number || '—')}</b></div>
      <div><span class="erp-mini">PI Status</span><br>${piBadge(ED.pi.status)}</div>
      <button class="sc-btn sm" style="margin-left:auto" data-act="openPI">🧾 Open Validation Report</button></div></div>` : '';
    el.innerHTML = kpis + docCard + piStrip;
  }

  async function renderItemsTab(el) {
    el.innerHTML = '<div data-el="receiving"></div><div data-el="lines"></div><div class="sc-summary" data-el="summary"></div>';
    renderLines();
    await renderReceivingProgress();
  }

  async function renderDeliveryTab(el) {
    let dns = [];
    try { dns = await listDeliveryNotes(ED.id); } catch (e) { dns = []; }
    el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🚚 Delivery Notes</h3>
        <span class="sc-badge none" style="margin-left:8px">${dns.length}</span></div>
      ${dns.length ? tableWrap(`<table class="sc-table"><thead><tr><th>DN Number</th><th>Date</th><th>Status</th><th class="num">Delivered Qty</th><th></th></tr></thead><tbody>
        ${dns.map((x) => `<tr class="sc-row-link" data-act="opendn" data-id="${x.id}">
          <td class="mono"><b>${esc(x.dn_number)}</b></td><td>${esc(x.dn_date || '')}</td>
          <td>${statusBadge(x.status)}</td><td class="num">${qty(x.total_cartons || 0)}</td>
          <td style="text-align:right;color:var(--text-muted)">→</td></tr>`).join('')}</tbody></table>`)
        : '<p style="font-size:12px;color:var(--text-muted);margin:0">No delivery notes yet — add one from the Delivery Notes module.</p>'}</div>`;
  }

  async function renderInvoicesTab(el) {
    let sis = [];
    try { sis = await listInvoices(ED.id); } catch (e) { sis = []; }
    el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Supplier Invoices</h3>
        <span class="sc-badge none" style="margin-left:8px">${sis.length}</span></div>
      ${sis.length ? tableWrap(`<table class="sc-table"><thead><tr><th>Invoice Number</th><th>Invoice Date</th><th class="num">Amount</th><th>Matching Status</th><th>Posted</th><th></th></tr></thead><tbody>
        ${sis.map((i) => {
          const posted = i.delivery_note && ['Received'].includes(i.delivery_note.status);
          return `<tr class="sc-row-link" data-act="opensi" data-id="${i.id}">
          <td class="mono"><b>${esc(i.invoice_number)}</b></td><td>${esc(i.invoice_date || '')}</td>
          <td class="num">${money(i.grand_total)}</td><td>${statusBadge(i.status)}</td>
          <td>${posted ? '<span class="sc-badge confirmed">Posted</span>' : '<span class="sc-badge none">—</span>'}</td>
          <td style="text-align:right;color:var(--text-muted)">→</td></tr>`; }).join('')}</tbody></table>`)
        : '<p style="font-size:12px;color:var(--text-muted);margin:0">No supplier invoices linked yet.</p>'}</div>`;
  }

  async function renderPoTimelineTab(el) {
    await renderTimelineTab(el, ED.id, '<div data-el="audit"></div>');
    await renderAuditTrail();
  }
}

// PI operational dashboard — the single screen of record for receiving.
// Per line: Ordered / Received (live) / Remaining / % / DN + GR counts / last
// receipt / Open-Partial-Completed status. Clicking a line drills into the
// linked delivery notes, goods receipts and received batches.
let DASH_ROWS = [];
let DASH_SHOW_ALL = false;
async function renderReceivingProgress() {
  const el = qs('[data-el="receiving"]', ROOT);
  if (!el || !ED.id) return;
  let dash;
  try { dash = await getReceivingDashboard(ED.id); } catch (e) { return; }
  if (!dash.rows.length) return;
  DASH_ROWS = dash.rows;
  paintDashboard(el, dash);
}

function paintDashboard(el, dash) {
  const s = dash.summary;
  const pct = s.ordered > 0 ? Math.min(100, Math.round((s.received / s.ordered) * 100)) : 0;
  const completedN = dash.rows.filter((r) => r.line_status === 'Completed').length;
  const hideDone = !DASH_SHOW_ALL && completedN > 0 && completedN < dash.rows.length;
  const visible = hideDone ? dash.rows.filter((r) => r.line_status !== 'Completed') : dash.rows;
  const bar = (p) => `<div style="display:flex;align-items:center;gap:8px"><div style="flex:1;height:6px;border-radius:4px;background:var(--border-light);overflow:hidden">
      <div style="width:${p}%;height:100%;background:${p >= 100 ? '#2FB344' : '#1971C2'}"></div></div><span style="font-size:11px;color:var(--text-muted);min-width:34px">${p}%</span></div>`;
  // a manually closed PO: whatever was not delivered is Cancelled
  const closedManually = ED.doc && ED.doc.close_reason && ['Closed', 'Financially Closed'].includes(ED.doc.status);
  const lineChip = (st, remaining) => (closedManually && Number(remaining) > 0)
    ? `<span class="sc-badge closed">${Number(remaining) > 0 && st !== 'Open' ? 'Partial · rest Cancelled' : 'Cancelled'}</span>`
    : `<span class="sc-badge ${st === 'Completed' ? 'confirmed' : st === 'Partial' ? 'pi' : 'none'}">${esc(st)}</span>`;
  const invChip = (st) => st === '—' ? '' : `<span class="sc-badge ${st === 'Matched' ? 'confirmed' : st === 'Disputed' ? 'closed' : st === 'Partially Matched' ? 'pi' : 'none'}">${esc(st)}</span>`;
  const rows = visible.map((r) => `<tr class="sc-row-link" data-act="drill" data-id="${DASH_ROWS.indexOf(r)}">
      <td class="mono"><b>${esc(r.item_code || '')}</b><div style="font-size:10.5px;color:var(--text-muted)">${esc(String(r.roshen_id || ''))}</div></td>
      <td style="font-size:12px">${esc((r.description || '').slice(0, 36))}</td>
      <td class="num">${qty(r.ordered_cases)}</td>
      <td class="num">${qty(r.delivered_cases)}${Number(r.disputed_cases) > 0 ? `<div style="font-size:10px;color:#F76707">${qty(r.disputed_cases)} disputed</div>` : ''}</td>
      <td class="num"><b>${qty(r.received_cases)}</b></td>
      <td class="num" style="color:${Number(r.remaining_cases) > 0 ? 'var(--text-primary)' : '#2FB344'}"><b>${qty(r.remaining_cases)}</b></td>
      <td style="min-width:100px">${bar(r.pct)}</td>
      <td class="num">${r.dn_count || '—'}</td>
      <td style="font-size:11.5px">${r.last_delivery_at ? esc(String(r.last_delivery_at).slice(0, 10)) : '—'}
        ${r.expected_arrival ? `<div style="font-size:10px;color:var(--text-muted)">next ETA ${esc(String(r.expected_arrival).slice(0, 16).replace('T', ' '))}</div>` : ''}</td>
      <td>${lineChip(r.line_status, r.remaining_cases)} ${invChip(r.invoice_status)}${r.shipment_status !== '—' && r.shipment_status !== 'Received' ? ' ' + statusBadge(r.shipment_status) : ''}</td></tr>`).join('');
  el.innerHTML = `<div class="sc-card">
    <div class="sc-card-h"><h3>📦 Delivery Progress</h3><div class="sc-spacer"></div>
      <span style="font-size:12.5px;color:var(--text-secondary)">Total Ordered <b>${qty(s.ordered)}</b> · Total Received <b>${qty(s.received)}</b> · Remaining <b>${qty(s.remaining)}</b> · Overall <b>${pct}%</b> · ${orderBadge(ED.header.status)}</span></div>
    <div style="display:flex;align-items:center;gap:14px;margin:0 0 8px">
      <p style="font-size:11.5px;color:var(--text-muted);margin:0;flex:1">Click a line to see its deliveries, receipts and batches. The PI closes automatically when everything is received.</p>
      ${completedN > 0 ? `<label style="font-size:11.5px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap">
        <input type="checkbox" data-el="showdone" ${DASH_SHOW_ALL ? 'checked' : ''}> show ${completedN} completed item(s)</label>` : ''}</div>
    ${tableWrap(`<table class="sc-table"><thead><tr><th>Item Code / Roshen</th><th>Description</th><th class="num">Ordered Qty</th><th class="num">Delivered Qty</th><th class="num">Received Qty</th><th class="num">Remaining Qty</th><th>Delivery Progress</th><th class="num">Deliveries</th><th>Last Delivery</th><th>Status</th></tr></thead><tbody>${rows ||
      '<tr><td colspan="10" style="text-align:center;color:var(--text-muted);padding:16px">All items completely received 🎉</td></tr>'}</tbody></table>`)}
  </div>`;
  const toggle = el.querySelector('[data-el="showdone"]');
  if (toggle) toggle.addEventListener('change', () => { DASH_SHOW_ALL = toggle.checked; paintDashboard(el, dash); });
}

function openLineDrill(r) {
  const d = r.drill || { dns: [], grs: [], batches: [] };
  const sec = (title, inner) => `<div class="sc-card-h" style="margin-top:12px"><h3>${title}</h3></div>${inner}`;
  const none = '<p style="font-size:12px;color:var(--text-muted);margin:0">None yet.</p>';
  modal(`${esc(r.roshen_id || r.item_code)} · receiving detail`, `
    <div style="display:flex;gap:18px;flex-wrap:wrap;font-size:12.5px;margin-bottom:4px">
      <div>Ordered <b>${qty(r.ordered_cases)}</b></div><div>Received <b>${qty(r.received_cases)}</b></div>
      <div>Remaining <b>${qty(r.remaining_cases)}</b></div><div><b>${r.pct}%</b> received</div></div>
    ${sec('🚚 Delivery Notes (' + d.dns.length + ')', d.dns.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.dns.map((x) => `<tr>
      <td class="mono"><b>${esc(x.dn_number)}</b></td><td>${esc(x.dn_date || '—')}</td>
      <td>${statusBadge(x.status)}</td>
      <td style="font-size:11px;color:var(--text-muted)">${x.expected_delivery_at ? 'ETA ' + esc(String(x.expected_delivery_at).slice(0, 16).replace('T', ' ')) : ''}</td>
      <td class="num"><b>${qty(x.cases)}</b> ctn</td></tr>`).join('')}</tbody></table>` : none)}
    ${sec('📦 Warehouse Receipts (' + d.grs.length + ')', d.grs.length ? `<table class="sc-table" style="min-width:0"><tbody>${d.grs.map((x) => `<tr>
      <td class="mono"><b>${esc(x.grn_number)}</b></td><td>${esc((x.released_at || x.receipt_date || '').slice(0, 10))}</td>
      <td>${statusBadge(x.status)}</td><td>${esc(x.warehouse || '—')}</td>
      <td class="num"><b>${qty(x.cases)}</b> received</td></tr>`).join('')}</tbody></table>` : none)}
    ${sec('🔖 Received batches (' + d.batches.length + ')', d.batches.length ? `<table class="sc-table" style="min-width:0"><thead><tr><th>Batch</th><th>Expiry</th><th class="num">Received</th><th class="num">On hand</th><th>QC</th><th>GRN</th></tr></thead><tbody>${d.batches.map((x) => `<tr>
      <td class="mono">${x.batch_id ? '#' + x.batch_id + ' · ' : ''}${esc(x.batch_no || '—')}</td>
      <td>${esc(x.expiry_date || '—')}</td>
      <td class="num">${qty(x.received_cases)}</td>
      <td class="num">${x.current_cases == null ? '—' : qty(x.current_cases)}</td>
      <td><span class="sc-badge ${x.qc_result === 'Released' ? 'confirmed' : 'closed'}">${esc(x.qc_result)}</span>${x.hold_status === 'on_hold' ? ' <span class="sc-badge closed">HOLD</span>' : ''}</td>
      <td class="mono" style="font-size:11px">${esc(x.grn_number || '')}</td></tr>`).join('')}</tbody></table>` : none)}`,
  [{ label: 'Close', cls: 'ghost' }]);
}

// Related Documents — the complete permanent document chain (PO → DNs → GRNs
// → SIs → replacement POs), shared component with one-click navigation.
async function renderRelatedDocs() {
  const el = qs('[data-el="related"]', ROOT);
  if (!el || !ED.id) return;
  await renderDocumentChain(el, (s, p) => CTX.navigate(s, p), { orderId: ED.id, current: { type: 'purchase_order', id: ED.id } });
}

// Business Timeline — the complete document journey (PO created → approved →
// DN created → shipment confirmed → receipt completed → invoice posted →
// delivered → closed), each event with date, time and user. Read-only.
async function renderTimeline() {
  const el = qs('[data-el="timeline"]', ROOT);
  if (!el || !ED.id) return;
  let events = [];
  try { events = await buildBusinessTimeline(ED.id); } catch (e) { return; }
  if (!events.length) return;
  el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🧭 Business Timeline</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${events.length}</span></div>
    <div class="erp-rev-timeline">${events.map((e) => `<div class="erp-rev">
      <div class="erp-rev-h"><b>${e.icon} ${esc(e.label)}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(e.user || '—')} · ${esc(String(e.at || '').slice(0, 16).replace('T', ' '))}</span></div></div>`).join('')}</div></div>`;
}

// Audit trail — the PI's lifecycle from the data it already carries:
// created / approved timestamps + every applied revision. Read-only.
async function renderAuditTrail() {
  const el = qs('[data-el="audit"]', ROOT);
  if (!el || !ED.id || !ED.doc) return;
  const d = ED.doc;
  let revs = [], poAudit = [];
  try { revs = await listRevisions(ED.id); } catch (e) { revs = []; }
  try { poAudit = await Orders.listOrderAudit(ED.id); } catch (e) { poAudit = []; }
  const fmt = (t) => esc(String(t || '').slice(0, 16).replace('T', ' '));
  const entries = [];
  if (d.created_at) entries.push({ icon: '➕', label: 'Created' + (d.source_filename ? ' from ' + d.source_filename : ''), by: d.created_by, at: d.created_at });
  (revs || []).forEach((r) => entries.push({ icon: '✏️', label: `Revision ${r.revision_no != null ? '#' + r.revision_no : ''} applied`, by: r.created_by, at: r.created_at }));
  if (d.approved_at) entries.push({ icon: '✅', label: 'Approved & locked', by: null, at: d.approved_at });
  (poAudit || []).forEach((a) => {
    const det = a.details || {};
    entries.push({
      icon: a.action === 'closed' ? '✖' : '🔖',
      label: a.action === 'closed'
        ? `Closed — ${det.reason || ''}${det.comments ? ' · ' + det.comments : ''}${det.replaced_by_order_id ? ' · replaced by PO #' + det.replaced_by_order_id : ''}`
        : a.action,
      by: a.actor, at: a.created_at,
    });
  });
  entries.push({ icon: '🔖', label: 'Current status: ' + (d.status || ''), by: null, at: d.updated_at });
  el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🕓 Audit Trail</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${entries.length}</span></div>
    <div class="erp-rev-timeline">${entries.map((a) => `<div class="erp-rev">
      <div class="erp-rev-h"><b>${a.icon} ${esc(a.label)}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(a.by || '—')} · ${fmt(a.at)}</span></div></div>`).join('')}</div></div>`;
}

function renderActions() {
  const h = ED.header, box = qs('[data-el="actions"]', ROOT);
  const isNew = ED.id == null;
  let btns = '';
  if (!ED.readonly) {
    btns += '<button class="sc-btn primary" data-act="save">💾 Save Draft</button>';
    btns += '<button class="sc-btn green" data-act="approve">✅ Approve PI</button>';
    if (isNew) btns += '<button class="sc-btn" data-act="importxl">📥 Import from Excel</button>';
  } else if (h.status === ORDER_STATUS.APPROVED) {
    btns += ED.pi ? '<button class="sc-btn primary" data-act="openPI">🧾 Open PI Validation</button>'
                  : '<button class="sc-btn primary" data-act="import">📥 Import PI</button>';
  } else if (h.status === ORDER_STATUS.PI_IMPORTED || h.status === ORDER_STATUS.PI_APPROVED) {
    if (ED.pi) btns += '<button class="sc-btn primary" data-act="openPI">🧾 Open PI Validation</button>';
  }
  // manual close — available while the order is not fully delivered/closed
  if (ED.id && ED.readonly && canCloseManually({ status: h.status })) {
    btns += '<button class="sc-btn ghost" style="color:#E03131" data-act="close">✖ Close Purchase Order</button>';
  }
  if (ED.id) btns += `<div style="margin-left:auto;display:flex;gap:8px">
    <button class="sc-btn ghost" data-act="dup">⧉ Duplicate</button>
    <button class="sc-btn ghost" data-act="print">🖨 Print</button>
    <button class="sc-btn ghost" data-act="xls">⬇ Excel</button>
    <button class="sc-btn" data-act="bizfile" title="Multi-sheet Excel: summary, items, DNs, invoices, receipts, timeline, audit">📊 Business File</button></div>`;
  box.innerHTML = btns;
}

function renderLines() {
  const ro = ED.readonly, box = qs('[data-el="lines"]', ROOT);
  if (!ED.lines.length) {
    box.innerHTML = `<div class="sc-empty"><div class="ic">📦</div><p>No items yet.${ro ? '' : ' Search above to add SKUs to this order.'}</p></div>`;
    updateSummary(); return;
  }
  // Imported document lines are shown with the document's own columns.
  const hasDoc = ED.lines.some((l) => l.units_qty != null || l.amount != null || l.uom);
  if (ro && hasDoc) {
    const cur = (ED.doc && ED.doc.currency) || 'SAR';
    const hasDisc = ED.lines.some((l) => Number(l.discount_percent) > 0);
    const cell = (v, f) => `<td class="num">${v == null ? '—' : f(v)}</td>`;
    const rows = ED.lines.map((l, i) => `<tr>
        <td>${l.line_no || i + 1}</td>
        <td class="mono"><b>${esc(l.supplier_item_code || l.item_code || '')}</b>${l.supplier_item_code && l.item_code && l.supplier_item_code !== l.item_code ? `<div style="font-size:10px;color:var(--text-muted)">${esc(l.item_code)}</div>` : ''}</td>
        <td class="mono">${esc(l.roshen_id || '—')}</td>
        <td style="font-size:12px;min-width:220px">${esc(l.item_description || '')}</td>
        <td>${esc(l.uom || '—')}</td>
        ${cell(l.units_qty, qty)}
        <td class="num"><b>${qty(l.ordered_cases)}</b></td>
        ${cell(l.unit_price, money)}
        ${hasDisc ? `<td class="num">${l.discount_percent == null ? '—' : esc(String(l.discount_percent)) + '%'}</td>${cell(l.net_unit_price, money)}` : ''}
        ${cell(l.taxable_amount, money)}
        <td class="num">${l.vat_percent == null ? '—' : esc(String(l.vat_percent))}</td>
        ${cell(l.vat_amount, money)}
        <td class="num"><b>${l.amount == null ? '—' : money(l.amount)}</b></td>
      </tr>`).join('');
    box.innerHTML = tableWrap(`<table class="sc-table"><thead><tr>
      <th>No.</th><th>Item Code</th><th>Roshen Code</th><th>Item Description</th><th>Unit</th>
      <th class="num">Units</th><th class="num">Ordered Qty</th><th class="num">Price (${esc(cur)})</th>
      ${hasDisc ? `<th class="num">Discount %</th><th class="num">Price after Discount</th>` : ''}
      <th class="num">Taxable (${esc(cur)})</th><th class="num">VAT %</th><th class="num">VAT (${esc(cur)})</th><th class="num">Amount (${esc(cur)})</th></tr></thead><tbody>${rows}</tbody></table>`);
    updateSummary(); return;
  }
  const rows = ED.lines.map((l, i) => {
    const lt = (Number(l.price_case) || 0) * (Number(l.ordered_cases) || 0);
    return `<tr>
      <td>${i + 1}</td><td class="mono">${esc(l.item_code)}</td><td class="mono">${esc(l.roshen_id || '—')}</td>
      <td>${esc(l.item_description || '')}</td><td class="num">${money(l.price_case)}</td>
      <td class="num">${ro ? qty(l.ordered_cases) : `<input class="sc-input sc-qty-input" data-qty="${i}" type="number" min="0" step="1" value="${esc(l.ordered_cases)}">`}</td>
      <td class="num" data-lt="${i}"><b>${money(lt)}</b></td>
      ${ro ? '' : `<td class="num"><button class="sc-row-remove" title="Remove" data-act="removeLine" data-id="${i}">×</button></td>`}
    </tr>`;
  }).join('');
  box.innerHTML = tableWrap(`<table class="sc-table"><thead><tr><th>#</th><th>Item Code</th><th>Roshen ID</th><th>Description</th><th class="num">Price / Case (SAR)</th><th class="num">Ordered Cases</th><th class="num">Line Total (SAR)</th>${ro ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table>`);
  box.querySelectorAll('[data-qty]').forEach((inp) => inp.addEventListener('input', () => onQty(+inp.dataset.qty, inp)));
  updateSummary();
}

function onQty(i, inp) {
  let v = parseFloat(inp.value); if (isNaN(v)) v = '';
  ED.lines[i].ordered_cases = v;
  const lt = (Number(ED.lines[i].price_case) || 0) * (Number(v) || 0);
  const cell = qs(`[data-lt="${i}"]`, ROOT); if (cell) cell.innerHTML = `<b>${money(lt)}</b>`;
  updateSummary();
}

function updateSummary() {
  const box = qs('[data-el="summary"]', ROOT); if (!box) return;
  let cases = 0;
  ED.lines.forEach((l) => { cases += Number(l.ordered_cases) || 0; });
  const d = ED.doc;
  // The document's own totals are the source of truth when this PI was
  // imported from a supplier document; computed totals otherwise.
  if (ED.readonly && d && (d.total_gross != null || d.total_net != null)) {
    const cur = d.currency || 'SAR';
    box.innerHTML = `
      <div class="sc-sum-card"><div class="lbl">Number of Items</div><div class="val">${ED.lines.length}</div></div>
      <div class="sc-sum-card"><div class="lbl">Total Ordered Qty</div><div class="val">${qty(cases)}</div></div>
      ${d.total_net != null ? `<div class="sc-sum-card"><div class="lbl">Total Net (${esc(cur)})</div><div class="val">${money(d.total_net)}</div></div>` : ''}
      ${d.total_vat != null ? `<div class="sc-sum-card"><div class="lbl">Total VAT (${esc(cur)})</div><div class="val">${money(d.total_vat)}</div></div>` : ''}
      ${d.total_gross != null ? `<div class="sc-sum-card grand"><div class="lbl">Grand Total (${esc(cur)})</div><div class="val">${money(d.total_gross)}</div></div>` : ''}`;
    return;
  }
  let total = 0;
  ED.lines.forEach((l) => { total += (Number(l.price_case) || 0) * (Number(l.ordered_cases) || 0); });
  box.innerHTML = `
    <div class="sc-sum-card"><div class="lbl">Number of Items</div><div class="val">${ED.lines.length}</div></div>
    <div class="sc-sum-card"><div class="lbl">Total Cases</div><div class="val">${qty(cases)}</div></div>
    <div class="sc-sum-card grand"><div class="lbl">Grand Total (SAR)</div><div class="val">${money(total)}</div></div>`;
}

function addItem(code) {
  const sku = SKU_BY_CODE[code]; if (!sku) return;
  const existing = ED.lines.find((l) => l.item_code === code);
  if (existing) {
    modal('Duplicate item',
      `<b>${esc(sku.item_code)}</b> — ${esc(sku.item_description)} is already in this order (current quantity <b>${qty(existing.ordered_cases)}</b> cases).<br><br>Merge the quantity (add one case) or keep a single line?`,
      [{ label: 'Merge (+1 case)', cls: 'primary', onClick: () => { existing.ordered_cases = (Number(existing.ordered_cases) || 0) + 1; renderLines(); toast('Quantity merged', 'ok'); } },
       { label: 'Cancel (no duplicate)', cls: 'ghost' }]);
    return;
  }
  ED.lines.push({ item_code: sku.item_code, roshen_id: sku.roshen_id, item_description: sku.item_description, price_case: Number(sku.price_case), ordered_cases: 1 });
  renderLines();
}

function validate() {
  if (!ED.lines.length) { toast('Add at least one item before saving', 'err'); return false; }
  const seen = {};
  for (let i = 0; i < ED.lines.length; i++) {
    const l = ED.lines[i];
    if (!(Number(l.ordered_cases) > 0)) { toast(`Quantity must be greater than zero — line ${i + 1} (${l.item_code})`, 'err'); return false; }
    if (seen[l.item_code]) { toast('Duplicate SKU in order: ' + l.item_code, 'err'); return false; }
    seen[l.item_code] = true;
  }
  return true;
}

async function save(thenApprove) {
  if (!validate()) return;
  const header = {
    order_date: qs('[data-el="order_date"]', ROOT).value || today(),
    supplier: (qs('[data-el="supplier"]', ROOT).value || 'Roshen').trim(),
    warehouse: qs('[data-el="warehouse"]', ROOT).value.trim() || null,
    expected_arrival: qs('[data-el="expected_arrival"]', ROOT).value || null,
    notes: qs('[data-el="notes"]', ROOT).value.trim() || null,
  };
  try {
    if (ED.id == null) {
      const row = await Orders.createOrder(header);
      ED.id = row.id; ED.header.order_number = row.order_number; ED.header.status = row.status;
    } else {
      await Orders.updateHeader(ED.id, header);
    }
    await Orders.replaceItems(ED.id, ED.lines.map((l) => {
      const row = {
        item_code: l.item_code, roshen_id: l.roshen_id, item_description: l.item_description,
        ordered_cases: Number(l.ordered_cases), price_case: Number(l.price_case) || null,
      };
      DOC_LINE_FIELDS.forEach((f) => { if (l[f] != null) row[f] = l[f]; });
      return row;
    }));
  } catch (e) { toast('Save failed: ' + (e.message || e), 'err'); return; }

  if (thenApprove) confirmApprove();
  else { toast('Draft saved · ' + ED.header.order_number, 'ok'); paint(); }
}

function confirmApprove() {
  modal('Approve purchase order?',
    'Approving locks the order from further editing and makes it the official reference document for the imported Proforma Invoice. Continue?',
    [{ label: 'Approve & Lock', cls: 'green', onClick: async () => {
        try { await Orders.approve(ED.id); } catch (e) { toast('Approve failed: ' + e.message, 'err'); return; }
        toast('Order approved & locked', 'ok'); await openOrder(ED.id, 'view');
      } }, { label: 'Cancel', cls: 'ghost' }]);
}

const ACTIONS = {
  back: () => CTX.navigate('purchase-orders'),
  importxl: () => CTX.navigate('import-order'),
  drill: (d) => { const r = DASH_ROWS[+d.id]; if (r) openLineDrill(r); },
  opendn: (d) => CTX.navigate('delivery-notes', { view: 'detail', dnId: +d.id }),
  opensi: (d) => CTX.navigate('supplier-invoices', { view: 'detail', invoiceId: +d.id }),
  unlock: () => { if (ED.header.status === ORDER_STATUS.DRAFT) { ED.readonly = false; paint(); } },
  save: () => save(false),
  approve: () => save(true),
  openPI: () => CTX.navigate('validation', { piId: ED.pi && ED.pi.id }),
  import: () => CTX.navigate('pi-import', { orderId: ED.id }),
  dup: () => CTX.navigate('purchase-orders', { duplicateFrom: ED.id }),
  removeLine: (d) => { ED.lines.splice(+d.id, 1); renderLines(); },
  print: () => { if (!printOrder(pseudoOrder())) toast('Allow pop-ups to print', 'err'); },
  xls: () => { exportOrderExcel(pseudoOrder()); toast('Exported', 'ok'); },
  bizfile: async () => {
    try { await exportOrderBusinessFile(ED.id); toast('Business file exported — 7 sheets', 'ok'); }
    catch (e) { toast(e.message || String(e), 'err'); }
  },
  goorder: (d) => CTX.navigate('purchase-orders', { orderId: +d.id, mode: 'view' }),
  close: async () => {
    let candidates = [];
    try { candidates = await Orders.listReplacementCandidates(ED.id); } catch (e) { /* optional */ }
    modal(`Close Purchase Order ${esc(ED.header.order_number)}?`, `
      <p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">A business action, not a delete: the order keeps its history, undelivered quantities become <b>Cancelled</b>, no new delivery notes or supplier invoices can be created, and the order moves to Purchase History.</p>
      <div class="sc-field"><label>Close Reason *</label>
        <select class="sc-select" data-cl="reason"><option value="">— select a reason —</option>
          ${CLOSE_REASONS.map((r) => `<option>${esc(r)}</option>`).join('')}</select></div>
      <div class="sc-field" style="margin-top:8px"><label>Comments <span style="color:var(--text-muted)">(required for “Other”)</span></label>
        <textarea class="sc-input" data-cl="comments" rows="2"></textarea></div>
      <div class="sc-field" style="margin-top:8px"><label>Closed By *</label>
        <input class="sc-input" data-cl="by" placeholder="Your name"></div>
      <div class="sc-field" style="margin-top:8px"><label>Replaced by Purchase Order</label>
        <select class="sc-select" data-cl="repl"><option value="">— none —</option>
          ${candidates.map((r) => `<option value="${r.id}">${esc(r.order_number)}</option>`).join('')}</select></div>`,
      [{ label: '✖ Close Purchase Order', cls: 'primary', onClick: async () => {
          // the modal DOM persists after close() — inputs are still readable
          const v = (k) => { const n = document.querySelector(`[data-cl="${k}"]`); return n ? n.value.trim() : ''; };
          const reason = v('reason'), comments = v('comments'), by = v('by'), repl = v('repl');
          if (!reason) return toast('Select a close reason — the order was NOT closed', 'err');
          if (reason === 'Other' && !comments) return toast('Add a comment explaining the reason — the order was NOT closed', 'err');
          if (!by) return toast('Enter who is closing the order — the order was NOT closed', 'err');
          try {
            await Orders.closeOrderManually(ED.id, { reason, comments, closedBy: by, replacedByOrderId: repl ? +repl : null });
          } catch (e) { return toast(e.message || String(e), 'err'); }
          toast('Purchase order closed — moved to Purchase History', 'ok');
          await openOrder(ED.id, 'view');
        } },
       { label: 'Cancel', cls: 'ghost' }]);
  },
};
