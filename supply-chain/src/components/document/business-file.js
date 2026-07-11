// Business File — the complete DOCUMENT TREE of a purchase order and the
// primary navigation screen for its lifecycle. V2.5: every delivery-note node
// tells the whole story WITHOUT opening it —
//
//   · progress tracker  PI ✔ → Delivery Note ✔ → Goods Receipt ✔ →
//                       Supplier Invoice ○ → Matched ○   (real data only)
//   · always-visible summary: Shipped · Received · Variance · Batches ·
//     Amount · Attachments
//   · variance badge: red (shipped ≠ received), amber (awaiting receipt /
//     order not fully shipped on the PI node), green (balanced)
//   · expanded: per-note business timeline from actual timestamps
//   · quick actions on every document: preview / download / upload /
//     copy number / open — no navigation required
//
// Every delivery note shows ONLY its own receipt, invoice and attachments —
// relationships come from the existing services (listDeliveryNotes joins each
// note to ITS active receipt and ITS primary invoice). Statuses use the shared
// badge vocabulary. Attachment COUNTS and the quick preview/download come from
// one chain-wide sweep; each node's full attachment panel (upload, drag &
// drop, versions) is the standard panel, mounted LAZILY on first open.
// Amounts use the same rule as invoice validation: the invoice net when one
// exists, else delivered cases × approved PO price. Expanded state is
// remembered per order.
import { esc, money, qty, lineKey } from '../../utils/format.js';
import { attachmentsPanel, previewAttachment } from '../attachments/attachments-panel.js';
import { listChainAttachments, attachmentUrl, canPreview } from '../../services/attachments/attachments.service.js';
import { statusBadge } from '../table/badges.js';
import { toast } from '../notifications/toast.js';
import { t } from '../../i18n/i18n.js';
import { getClient } from '../../services/supabase/client.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';
import { buildBusinessTimeline } from '../../services/timeline/business-timeline.service.js';

const MEM_KEY = (orderId) => 'sc-bizfile-open:' + orderId;
const openSet = (orderId) => {
  try { return new Set(JSON.parse(localStorage.getItem(MEM_KEY(orderId)) || '[]')); } catch (e) { return new Set(); }
};
const saveOpen = (orderId, set) => { try { localStorage.setItem(MEM_KEY(orderId), JSON.stringify([...set])); } catch (e) { /* private mode */ } };

const attChip = (label, n) => (n > 0
  ? `<span class="sc-badge none" title="attachments on this document">📎 ${esc(label)} (${n})</span>`
  : '<span class="sc-badge closed" title="no file uploaded for this document">Missing Attachment</span>');
const d10 = (t) => esc(String(t || '').slice(0, 10));
const dDay = (t) => { const s = String(t || '').slice(0, 10); const d = new Date(s + 'T00:00:00'); return isNaN(d) ? s : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); };
const kv = (l, v) => `<div class="bf-kv"><span>${l}</span><b>${v}</b></div>`;
const stat = (l, v, cls = '') => `<span class="bf-stat ${cls}"><span>${l}</span><b>${v}</b></span>`;
const emptyNode = (icon, title, note) =>
  `<div class="bf-node bf-child bf-pending"><div class="bf-empty">${icon} ${title} <span>— ${note}</span></div></div>`;

// horizontal progress tracker — every step from real business data
const tracker = (steps) => `<div class="bf-track">${steps.map((s, i) =>
  `${i ? '<span class="bf-track-line"></span>' : ''}<span class="bf-step ${s.done ? 'done' : ''}" title="${esc(s.title || '')}">${s.done ? '✔' : '○'} ${esc(s.label)}</span>`).join('')}</div>`;

// Every "Business File" button in the app lands on the dedicated Business
// Files page — the drawer is gone. Same signature as before, so every existing
// caller (PO, Delivery Note, Goods Receipt, Supplier Invoice, …) is migrated
// without being touched.
export function openBusinessFile(orderId, navigate) {
  if (navigate) navigate('business-files', { orderId });
}

// The Business File workspace itself — renders the complete document tree into
// any host element (today: the Business Files page). Returns a small handle
// the page uses for its header actions (order info + the print/PDF document).
export async function renderBusinessFile(body, orderId, navigate) {
  body.innerHTML = '<div class="sk-page-head"><span class="sc-spin" style="width:13px;height:13px"></span> <span>Loading the document chain…</span></div>';
  const c = getClient();

  // wave 1 — the order + its delivery notes (each already joined to ITS active
  // receipt and ITS primary invoice by the existing service)
  const [{ data: order }, dns] = await Promise.all([
    c.from('supply_orders').select('id,order_number,order_date,supplier,status,close_reason').eq('id', orderId).single(),
    listDeliveryNotes(orderId),
  ]);
  const notes = (dns || []).slice().sort((a, b) => String(a.dn_number).localeCompare(String(b.dn_number)));
  const dnIds = notes.map((d) => d.id);
  const grIds = notes.map((d) => d.goods_receipt && d.goods_receipt.id).filter(Boolean);
  const siIds = notes.map((d) => d.invoice && d.invoice.id).filter(Boolean);

  // wave 2 — chain details, one bulk query per table (no per-node calls)
  const [fulQ, sisQ, grsQ, grbQ, dnbQ, dnAudQ, siAudQ, atts, timeline] = await Promise.all([
    c.from('po_line_fulfillment').select('roshen_id,item_code,ordered_cases,price_case').eq('order_id', orderId),
    c.from('supplier_invoices').select('id,invoice_number,status,doc_type,currency,total_taxable,total_vat,grand_total,created_at').eq('order_id', orderId),
    grIds.length ? c.from('goods_receipts').select('id,grn_number,status,released_at').in('id', grIds) : { data: [] },
    grIds.length ? c.from('goods_receipt_batches').select('gr_id,received_cases,qc_result').in('gr_id', grIds) : { data: [] },
    dnIds.length ? c.from('delivery_note_items').select('dn_id,roshen_id,item_code, delivery_note_batches(id,cases)').in('dn_id', dnIds) : { data: [] },
    dnIds.length ? c.from('dn_audit_log').select('dn_id,action,detail,created_at').in('dn_id', dnIds) : { data: [] },
    siIds.length ? c.from('supplier_invoice_audit_log').select('invoice_id,action,created_at').in('invoice_id', siIds).eq('action', 'matched') : { data: [] },
    listChainAttachments(orderId).catch(() => []),        // ONE sweep: counters + search + quick preview/download
    buildBusinessTimeline(orderId).catch(() => []),
  ]);
  const siById = {}; (sisQ.data || []).forEach((s) => { siById[s.id] = s; });
  const grById = {}; (grsQ.data || []).forEach((g) => { grById[g.id] = g; });
  const recvByGr = {};
  (grbQ.data || []).forEach((b) => { if (b.qc_result === 'Released') recvByGr[b.gr_id] = (recvByGr[b.gr_id] || 0) + Number(b.received_cases || 0); });
  const priceByKey = {}; let orderedTotal = 0;
  (fulQ.data || []).forEach((r) => { priceByKey[lineKey(r.roshen_id, r.item_code)] = Number(r.price_case || 0); orderedTotal += Number(r.ordered_cases || 0); });
  const batchesByDn = {}, amountByDn = {};
  (dnbQ.data || []).forEach((r) => {
    const cases = (r.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    batchesByDn[r.dn_id] = (batchesByDn[r.dn_id] || 0) + (r.delivery_note_batches || []).length;
    amountByDn[r.dn_id] = (amountByDn[r.dn_id] || 0) + cases * (priceByKey[lineKey(r.roshen_id, r.item_code)] || 0);
  });
  const dispatchedAt = {};    // dn_id → In-Transit timestamp (from the audit trail)
  (dnAudQ.data || []).forEach((a) => {
    if (a.action === 'status_change' && a.detail && a.detail.to === 'In Transit' && !dispatchedAt[a.dn_id]) dispatchedAt[a.dn_id] = a.created_at;
  });
  const matchedAt = {};       // invoice_id → matched timestamp
  (siAudQ.data || []).forEach((a) => { if (!matchedAt[a.invoice_id]) matchedAt[a.invoice_id] = a.created_at; });
  const attCount = {}, attNames = {}, attsByKey = {};
  (atts || []).forEach((a) => {
    const k = a.doc_type + '|' + a.doc_id;
    attCount[k] = (attCount[k] || 0) + 1;
    (attNames[k] = attNames[k] || []).push(String(a.filename || '').toLowerCase());
    (attsByKey[k] = attsByKey[k] || []).push(a);
  });
  const nAtt = (t, id) => attCount[t + '|' + id] || 0;
  const names = (t, id) => attNames[t + '|' + id] || [];

  const piTotal = (fulQ.data || []).reduce((a, r) => a + Number(r.ordered_cases || 0) * Number(r.price_case || 0), 0);
  const withCurrency = (sisQ.data || []).find((s) => s.currency);
  const currency = withCurrency ? withCurrency.currency : 'SAR';
  const grCount = grIds.length;
  const siCount = notes.filter((d) => d.invoice).length;
  const shippedTotal = notes.reduce((a, d) => a + Number(d.total_cartons || 0), 0);

  // ---- render ---------------------------------------------------------------
  const open = openSet(orderId);
  const isOpen = (k) => open.has(k);

  // quick actions for one document — preview/download use the chain sweep, no
  // extra queries; upload expands the node and opens its standard drop zone
  const quick = (docType, docId, number, nodeKey) => {
    const list = attsByKey[docType + '|' + docId] || [];
    const canPrev = list.some((a) => canPreview(a));
    return `<span class="bf-qa">
      <button class="bf-qbtn" data-qa="preview" data-doc="${docType}:${docId}" title="Preview attachment" ${canPrev ? '' : 'disabled'}>👁</button>
      <button class="bf-qbtn" data-qa="download" data-doc="${docType}:${docId}" title="Download attachment" ${list.length ? '' : 'disabled'}>⬇</button>
      <button class="bf-qbtn" data-qa="upload" data-doc="${docType}:${docId}" data-key="${nodeKey}" title="Upload attachment">📤</button>
      <button class="bf-qbtn" data-qa="copy" data-num="${esc(number)}" title="Copy document number">⧉</button>
    </span>`;
  };

  const grNode = (d) => {
    const gr = d.goods_receipt ? grById[d.goods_receipt.id] : null;
    if (!gr) return emptyNode('📦', 'Goods Receipt Pending', 'waiting for receiving');
    const key = 'gr' + gr.id;
    return `<div class="bf-node bf-child ${isOpen(key) ? 'open' : ''}" data-node="${key}"
      data-search="${esc(String(gr.grn_number).toLowerCase())} ${esc(names('goods_receipt', gr.id).join(' '))}">
      <div class="bf-head" data-toggle="${key}">
        <span class="bf-caret">▸</span><span class="bf-ic">📦</span>
        <b class="mono">${esc(gr.grn_number)}</b> ${statusBadge(gr.status)} ${attChip('GR', nAtt('goods_receipt', gr.id))}
        <span class="bf-meta">Received <b>${qty(recvByGr[gr.id] || 0)}</b>${gr.released_at ? ' · released ' + d10(gr.released_at) : ''}</span>
        ${quick('goods_receipt', gr.id, gr.grn_number, key)}
        <button class="sc-btn sm ghost bf-open" data-nav="goods-receiving" data-p='${esc(JSON.stringify({ view: 'detail', grId: gr.id }))}'>↗ Open</button>
      </div>
      <div class="bf-body">
        <div class="bf-info">${kv('Receipt', esc(gr.grn_number))}${kv('Status', statusBadge(gr.status))}${kv('Released', gr.released_at ? d10(gr.released_at) : '—')}${kv('Received Qty', qty(recvByGr[gr.id] || 0))}</div>
        <div class="bf-atts" data-att="goods_receipt:${gr.id}"></div>
      </div></div>`;
  };
  const siNode = (d) => {
    const si = d.invoice ? siById[d.invoice.id] : null;
    if (!si) return emptyNode('🧾', 'Supplier Invoice Pending', 'no invoice uploaded for this delivery yet');
    const key = 'si' + si.id;
    return `<div class="bf-node bf-child ${isOpen(key) ? 'open' : ''}" data-node="${key}"
      data-search="${esc(String(si.invoice_number).toLowerCase())} ${esc(names('supplier_invoice', si.id).join(' '))}">
      <div class="bf-head" data-toggle="${key}">
        <span class="bf-caret">▸</span><span class="bf-ic">🧾</span>
        <b class="mono">${esc(si.invoice_number)}</b> ${statusBadge(si.status)} ${attChip('Invoice', nAtt('supplier_invoice', si.id))}
        <span class="bf-meta">Net <b>${money(si.total_taxable)}</b></span>
        ${quick('supplier_invoice', si.id, si.invoice_number, key)}
        <button class="sc-btn sm ghost bf-open" data-nav="supplier-invoices" data-p='${esc(JSON.stringify({ view: 'detail', invoiceId: si.id }))}'>↗ Open</button>
      </div>
      <div class="bf-body">
        <div class="bf-info">${kv('Invoice', esc(si.invoice_number))}${kv('Match Status', statusBadge(si.status))}${kv('Net', money(si.total_taxable))}${kv('VAT', money(si.total_vat))}${kv('Gross', money(si.grand_total))}</div>
        <div class="bf-atts" data-att="supplier_invoice:${si.id}"></div>
      </div></div>`;
  };

  const dnNode = (d) => {
    const key = 'dn' + d.id;
    const shipped = Number(d.total_cartons || 0);
    const gr = d.goods_receipt ? grById[d.goods_receipt.id] : null;
    const si = d.invoice ? siById[d.invoice.id] : null;
    const grReleased = !!(gr && ['Released', 'Partially Released'].includes(gr.status));
    const received = gr ? (recvByGr[gr.id] || 0) : 0;
    const variance = +(shipped - received).toFixed(2);
    const amount = si ? Number(si.total_taxable || 0) : (amountByDn[d.id] || 0);
    // variance highlight: red = shipped ≠ received on a released receipt;
    // amber = not received yet; green = balanced
    const vBadge = grReleased
      ? (variance !== 0 ? `<span class="sc-badge closed">⚠ Variance ${qty(variance)}</span>` : '<span class="sc-badge confirmed">✔ Balanced</span>')
      : '<span class="sc-badge pi">○ Awaiting receipt</span>';
    const steps = tracker([
      { label: 'PI', done: true, title: order.order_number },
      { label: 'Delivery Note', done: true, title: d.dn_number },
      { label: 'Goods Receipt', done: grReleased, title: gr ? gr.grn_number + ' · ' + gr.status : 'pending' },
      { label: 'Supplier Invoice', done: !!si, title: si ? si.invoice_number : 'pending' },
      { label: 'Matched', done: !!(si && si.status === 'Matched'), title: si ? si.status : 'pending' },
    ]);
    // per-note business timeline — actual timestamps only
    const tl = [
      { at: d.imported_at, label: 'Delivery Note Imported' },
      { at: dispatchedAt[d.id], label: 'Dispatched' },
      { at: gr && gr.released_at, label: 'Goods Receipt Released' },
      { at: d.received_at, label: 'Delivery Received' },
      { at: si && si.created_at, label: 'Supplier Invoice Imported' },
      { at: si && matchedAt[si.id], label: 'Matched' },
    ].filter((e) => e.at).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const subSearch = [
      String(d.dn_number).toLowerCase(), ...names('delivery_note', d.id),
      gr ? String(gr.grn_number).toLowerCase() : '', ...(gr ? names('goods_receipt', gr.id) : []),
      si ? String(si.invoice_number).toLowerCase() : '', ...(si ? names('supplier_invoice', si.id) : []),
    ].join(' ');
    return `<div class="bf-node bf-dn ${isOpen(key) ? 'open' : ''}" data-node="${key}" id="bf-${key}" data-search="${esc(subSearch)}">
      <div class="bf-head" data-toggle="${key}">
        <span class="bf-caret">▸</span><span class="bf-ic">🚚</span>
        <b class="mono">${esc(d.dn_number)}</b> ${statusBadge(d.status)} ${vBadge} ${attChip('DN', nAtt('delivery_note', d.id))}
        <span class="bf-meta">${d10(d.dn_date)}</span>
        ${quick('delivery_note', d.id, d.dn_number, key)}
        <button class="sc-btn sm ghost bf-open" data-nav="delivery-notes" data-p='${esc(JSON.stringify({ view: 'detail', dnId: d.id }))}'>↗ Open</button>
        ${steps}
        <span class="bf-stats">
          ${stat('Shipped', qty(shipped))}${stat('Received', qty(received), grReleased && variance !== 0 ? 'bad' : '')}
          ${stat('Variance', qty(variance), variance !== 0 && grReleased ? 'bad' : '')}${stat('Batches', batchesByDn[d.id] || 0)}
          ${stat('Amount', money(amount))}${stat('📎', nAtt('delivery_note', d.id))}
        </span>
      </div>
      <div class="bf-body">
        <div class="bf-info">
          ${kv('Date', d10(d.dn_date))}${kv('Status', statusBadge(d.status))}${kv('Shipped Qty', qty(shipped))}
          ${kv('Received Qty', qty(received))}${kv('Variance', variance === 0 ? '0' : qty(variance))}${kv('Batches', batchesByDn[d.id] || 0)}
        </div>
        ${tl.length ? `<div class="bf-minitl">${tl.map((e) => `<div class="bf-tl-row"><span class="bf-tl-date">${dDay(e.at)}</span><span class="bf-tl-dot"></span><span>${esc(e.label)}</span></div>`).join('')}</div>` : ''}
        <div class="bf-atts" data-att="delivery_note:${d.id}"></div>
        <div class="bf-children">
          ${grNode(d)}
          ${siNode(d)}
        </div>
      </div></div>`;
  };

  const piBadge = orderedTotal > 0 && shippedTotal >= orderedTotal
    ? '<span class="sc-badge confirmed">✔ Fully shipped</span>'
    : `<span class="sc-badge pi">△ Partially shipped ${qty(shippedTotal)}/${qty(orderedTotal)}</span>`;

  body.innerHTML = `
    <div class="bf-sticky">
      <div class="bf-cards">
        <button class="bf-card" data-scroll="bf-pi"><span>Purchase Invoices</span><b>1</b></button>
        <button class="bf-card" data-scroll="bf-dnsec"><span>Delivery Notes</span><b>${notes.length}</b></button>
        <button class="bf-card" data-scroll="bf-dnsec"><span>Goods Receipts</span><b>${grCount}</b></button>
        <button class="bf-card" data-scroll="bf-dnsec"><span>Supplier Invoices</span><b>${siCount}</b></button>
        <button class="bf-card" data-scroll="bf-pi"><span>Total Attachments</span><b>${(atts || []).length}</b></button>
      </div>
      <div class="bf-search"><input class="sc-input" data-el="bfsearch" placeholder="🔎 Search document numbers and attachment names…"></div>
    </div>
    <div class="bf-tree">
      <div class="bf-root">🛒 Purchase Order</div>
      <div class="bf-node bf-pi ${isOpen('pi') ? 'open' : ''}" data-node="pi" id="bf-pi"
        data-search="${esc(String(order.order_number).toLowerCase())} ${esc(names('purchase_order', order.id).join(' '))}">
        <div class="bf-head" data-toggle="pi">
          <span class="bf-caret">▸</span><span class="bf-ic">📋</span>
          <b class="mono">${esc(order.order_number)}</b> ${statusBadge(order.status)} ${piBadge} ${attChip('PI', nAtt('purchase_order', order.id))}
          <span class="bf-meta">${t('Purchase Invoice')} · ${d10(order.order_date)} · ${esc(order.supplier || '')}</span>
          ${quick('purchase_order', order.id, order.order_number, 'pi')}
          <button class="sc-btn sm ghost bf-open" data-nav="purchase-orders" data-p='${esc(JSON.stringify({ orderId: order.id, mode: 'view' }))}'>↗ Open</button>
          <span class="bf-stats">
            ${stat('Ordered', qty(orderedTotal))}${stat('Shipped', qty(shippedTotal))}
            ${stat('Value', money(piTotal) + ' ' + esc(currency))}${stat('📎', nAtt('purchase_order', order.id))}
          </span>
        </div>
        <div class="bf-body">
          <div class="bf-info">
            ${kv('PI Number', esc(order.order_number))}${kv('PI Date', d10(order.order_date))}${kv('Status', statusBadge(order.status))}
            ${kv('Supplier', esc(order.supplier || '—'))}${kv('Currency', esc(currency))}${kv('Total Value', money(piTotal) + ' ' + esc(currency))}
          </div>
          <div class="bf-atts" data-att="purchase_order:${order.id}"></div>
        </div>
      </div>
      <div class="bf-sec" id="bf-dnsec"><h3>🚚 Delivery Notes</h3><span class="sc-badge none">${notes.length}</span>
        <span class="bf-secnote">each delivery note owns its goods receipt and its supplier invoice</span></div>
      ${notes.length ? notes.map(dnNode).join('') : '<div class="bf-empty" style="margin:8px 0">🚚 No deliveries yet <span>— waiting for the first delivery note</span></div>'}
      <div class="bf-empty bf-nomatch" style="display:none">🔎 No documents or attachments match <span>— clear the search to see the whole chain</span></div>
    </div>
    <div class="sc-card" style="margin-top:14px"><div class="sc-card-h"><h3>🧭 Business Timeline</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${(timeline || []).length}</span></div>
      ${(timeline || []).length ? `<div class="erp-rev-timeline">${timeline.map((e) => `<div class="erp-rev">
        <div class="erp-rev-h"><b>${e.icon} ${esc(e.label)}</b>
        <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(e.user || '—')} · ${esc(String(e.at || '').slice(0, 16).replace('T', ' '))}</span></div></div>`).join('')}</div>`
      : '<p style="font-size:12px;color:var(--text-muted);margin:0">No events yet.</p>'}
    </div>`;

  // ---- behaviour -------------------------------------------------------------
  const mounted = new Set();
  const mountAtts = (node) => {
    node.querySelectorAll('[data-att]').forEach((host) => {
      if (host.closest('.bf-node') !== node) return;    // children mount on their own toggle
      const id = host.dataset.att;
      if (mounted.has(id)) return;
      mounted.add(id);
      const [docType, docId] = id.split(':');
      attachmentsPanel(host, docType, Number(docId), { actor: 'business-file' });
    });
  };
  const toggle = (key, node, forceOpen) => {
    const on = forceOpen === true ? node.classList.add('open') || true : node.classList.toggle('open');
    if (on) { open.add(key); mountAtts(node); } else open.delete(key);
    saveOpen(orderId, open);
  };
  body.querySelectorAll('[data-toggle]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('.bf-open') || e.target.closest('.bf-qbtn')) return;
    toggle(h.dataset.toggle, h.closest('.bf-node'));
  }));
  body.querySelectorAll('.bf-node.open').forEach((n) => mountAtts(n));
  body.querySelectorAll('.bf-open').forEach((b) => b.addEventListener('click', () => {
    if (navigate) navigate(b.dataset.nav, JSON.parse(b.dataset.p || '{}'));
  }));
  body.querySelectorAll('.bf-card').forEach((cEl) => cEl.addEventListener('click', () => {
    const t = body.querySelector('#' + cEl.dataset.scroll);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // quick actions — preview/download from the chain sweep; upload opens the
  // node's standard panel and its file picker; copy uses the clipboard
  body.querySelectorAll('.bf-qbtn').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = b.dataset.qa;
    if (act === 'copy') {
      const n = b.dataset.num || '';
      (navigator.clipboard ? navigator.clipboard.writeText(n) : Promise.reject())
        .then(() => toast('Copied ' + n, 'ok'))
        .catch(() => { toast('Copy failed — ' + n, 'err'); });
      return;
    }
    const list = attsByKey[String(b.dataset.doc || '').replace(':', '|')] || [];
    if (act === 'preview') {
      const previewable = list.filter((a) => canPreview(a));
      if (!previewable.length) return toast('No previewable attachment on this document', 'info');
      previewAttachment(previewable[0], { list: previewable, index: 0 });
      return;
    }
    if (act === 'download') {
      const a = list[0];
      if (!a) return toast('No attachment on this document', 'info');
      const link = document.createElement('a');
      link.href = attachmentUrl(a) + '?download=' + encodeURIComponent(a.filename);
      link.download = a.filename; document.body.appendChild(link); link.click(); link.remove();
      return;
    }
    if (act === 'upload') {
      const node = b.closest('.bf-node');
      toggle(b.dataset.key, node, true);
      setTimeout(() => {
        const host = [...node.querySelectorAll('[data-att]')].find((x) => x.closest('.bf-node') === node);
        const drop = host && host.querySelector('[data-a="drop"]');
        if (drop) { drop.scrollIntoView({ behavior: 'smooth', block: 'center' }); drop.click(); }
        else toast('Attachments are still loading — try again in a second', 'info');
      }, 450);
    }
  }));

  // search: document numbers + attachment file names (index from the single sweep)
  const search = body.querySelector('[data-el="bfsearch"]');
  const noMatch = body.querySelector('.bf-nomatch');
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let hits = 0;
    body.querySelectorAll('.bf-tree > .bf-node, .bf-tree .bf-dn').forEach((n) => {
      const hit = !q || (n.dataset.search || '').includes(q);
      n.style.display = hit ? '' : 'none';
      if (hit) hits++;
      if (q && hit && !n.classList.contains('open') && n.classList.contains('bf-dn')) {
        n.classList.add('open'); mountAtts(n);
      }
    });
    body.querySelector('.bf-sec').style.display = q && !hits ? 'none' : '';
    noMatch.style.display = q && !hits ? '' : 'none';
    if (!q) body.querySelectorAll('.bf-dn').forEach((n) => n.classList.toggle('open', open.has(n.dataset.node)));
  });

  // ---- print / PDF document (page header actions) — from the data already
  // loaded above, no extra queries. One document serves both: PDF = landscape
  // letterhead, Print = the plain chain, both with repeating table headers.
  const printDoc = ({ pdf }) => {
    const w = window.open('', '_blank', 'width=1200,height=800');
    if (!w) return toast('Allow pop-ups to export', 'err');
    const rows = notes.map((d) => {
      const gr = d.goods_receipt ? grById[d.goods_receipt.id] : null;
      const si = d.invoice ? siById[d.invoice.id] : null;
      const shipped = Number(d.total_cartons || 0);
      const received = gr ? (recvByGr[gr.id] || 0) : 0;
      const amount = si ? Number(si.total_taxable || 0) : (amountByDn[d.id] || 0);
      return { dn: d.dn_number, date: String(d.dn_date || '').slice(0, 10), status: d.status,
        shipped, received, variance: +(shipped - received).toFixed(2),
        gr: gr ? gr.grn_number : '—', grs: gr ? gr.status : 'Pending',
        si: si ? si.invoice_number : '—', sis: si ? si.status : 'Pending',
        amount, atts: nAtt('delivery_note', d.id) + (gr ? nAtt('goods_receipt', gr.id) : 0) + (si ? nAtt('supplier_invoice', si.id) : 0) };
    });
    const tot = rows.reduce((a, r) => ({ s: a.s + r.shipped, r: a.r + r.received, a: a.a + r.amount }), { s: 0, r: 0, a: 0 });
    w.document.write(`<!doctype html><html><head><title>${esc(order.order_number)} — Business File</title><style>
      @page{size:A4 ${pdf ? 'landscape' : 'portrait'};margin:12mm}
      body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:${pdf ? '10px' : '10.5px'}}
      h1{font-size:16px;margin:0}.sub{color:#555;font-size:10px;margin:2px 0 10px}
      .logo{font-size:13px;font-weight:800;letter-spacing:.04em;margin-bottom:2px}
      .kpis{display:flex;gap:14px;margin:8px 0 12px;flex-wrap:wrap}
      .kpis div{border:1px solid #ccc;border-radius:6px;padding:5px 10px}
      .kpis span{display:block;font-size:8px;text-transform:uppercase;color:#777}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left}
      th{background:#efefef;font-size:9px;text-transform:uppercase} td.r{text-align:right}
      thead{display:table-header-group}tfoot td{font-weight:700;background:#f7f7f7}
      h2{font-size:12px;margin:14px 0 6px}.tl td{border:none;padding:2px 6px;font-size:9.5px}
      footer{position:fixed;bottom:0;right:0;font-size:8px;color:#888}
    </style></head><body>
      <div class="logo">🏭 Roshen / Relia — Supply Chain</div>
      <h1>Business File — ${esc(order.order_number)}</h1>
      <div class="sub">Supplier: ${esc(order.supplier || '—')} · PI date ${d10(order.order_date)} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</div>
      <div class="kpis">
        <div><span>Ordered</span><b>${qty(orderedTotal)}</b></div>
        <div><span>Shipped</span><b>${qty(shippedTotal)}</b></div>
        <div><span>Delivery Notes</span><b>${notes.length}</b></div>
        <div><span>Goods Receipts</span><b>${grCount}</b></div>
        <div><span>Supplier Invoices</span><b>${siCount}</b></div>
        <div><span>PI Value</span><b>${money(piTotal)} ${esc(currency)}</b></div>
        <div><span>Attachments</span><b>${(atts || []).length}</b></div>
      </div>
      <table><thead><tr><th>${t('Delivery Note')}</th><th>${t('Date')}</th><th>${t('Status')}</th><th class="r">${t('Shipped')}</th><th class="r">${t('Received')}</th><th class="r">${t('Variance')}</th>
        <th>${t('Goods Receipt')}</th><th>${t('Status')}</th><th>${t('Supplier Invoice')}</th><th>${t('Status')}</th><th class="r">${t('Amount')}</th><th class="r">📎</th></tr></thead>
      <tbody>${rows.map((r) => `<tr><td>${esc(r.dn)}</td><td>${esc(r.date)}</td><td>${esc(r.status)}</td>
        <td class="r">${qty(r.shipped)}</td><td class="r">${qty(r.received)}</td><td class="r">${r.variance ? qty(r.variance) : '0'}</td>
        <td>${esc(r.gr)}</td><td>${esc(r.grs)}</td><td>${esc(r.si)}</td><td>${esc(r.sis)}</td>
        <td class="r">${money(r.amount)}</td><td class="r">${r.atts}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="3">TOTAL — ${rows.length} delivery note(s)</td><td class="r">${qty(tot.s)}</td><td class="r">${qty(tot.r)}</td>
        <td class="r">${qty(+(tot.s - tot.r).toFixed(2))}</td><td colspan="4"></td><td class="r">${money(tot.a)}</td><td></td></tr></tfoot></table>
      <h2>${t('🧭 Business Timeline')}</h2>
      <table class="tl"><tbody>${(timeline || []).map((e) => `<tr><td>${esc(String(e.at || '').slice(0, 16).replace('T', ' '))}</td>
        <td>${esc(e.label)}</td><td>${esc(e.user || '—')}</td></tr>`).join('') || '<tr><td>No events yet.</td></tr>'}</tbody></table>
      <footer>Roshen / Relia Supply Chain · ${esc(order.order_number)} · page numbers added by the print dialog</footer>
    </body></html>`);
    w.document.close();
    setTimeout(() => { w.print(); }, 400);
  };

  return { order, dnCount: notes.length, grCount, siCount, attCount: (atts || []).length, print: printDoc };
}
