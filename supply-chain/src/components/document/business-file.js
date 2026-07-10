// Business File — the complete DOCUMENT TREE of a purchase order, the primary
// navigation screen for the whole PO lifecycle:
//
//   Purchase Order
//   └── Purchase Invoice (PI)          — info · attachments
//       ├── Delivery Note DN-…         — info · attachments
//       │   ├── Goods Receipt          — info · attachments (or Pending)
//       │   └── Supplier Invoice       — info · attachments (or Pending)
//       └── Delivery Note DN-… …
//
// Every delivery note shows ONLY its own receipt, its own invoice and its own
// attachments — the relationships come from the existing services
// (listDeliveryNotes joins each note to ITS active receipt and ITS primary
// invoice). Statuses use the shared badge vocabulary. Attachment COUNTS come
// from one chain-wide sweep (no per-node count queries); each node's full
// attachment panel (icon, name, date, by, size, preview, download, upload,
// drag & drop, versions) is the standard attachments panel, mounted LAZILY
// the first time that node opens. Expanded state is remembered per order.
import { esc, money, qty } from '../../utils/format.js';
import { openDrawer, closeDrawer } from './document-shell.js';
import { attachmentsPanel } from '../attachments/attachments-panel.js';
import { listChainAttachments } from '../../services/attachments/attachments.service.js';
import { statusBadge } from '../table/badges.js';
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
const kv = (l, v) => `<div class="bf-kv"><span>${l}</span><b>${v}</b></div>`;
const emptyNode = (icon, title, note) =>
  `<div class="bf-node bf-child bf-pending"><div class="bf-empty">${icon} ${title} <span>— ${note}</span></div></div>`;

export async function openBusinessFile(orderId, navigate) {
  const body = openDrawer('📁 Business File — complete document chain', '<div class="sk-page-head"><span class="sc-spin" style="width:13px;height:13px"></span> <span>Loading the document chain…</span></div>');
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

  // wave 2 — chain details, one query per table (no per-node calls)
  const [fulQ, sisQ, grsQ, grbQ, dnbQ, atts, timeline] = await Promise.all([
    c.from('po_line_fulfillment').select('ordered_cases,price_case').eq('order_id', orderId),
    c.from('supplier_invoices').select('id,invoice_number,status,doc_type,currency,total_taxable,total_vat,grand_total').eq('order_id', orderId),
    grIds.length ? c.from('goods_receipts').select('id,grn_number,status,released_at').in('id', grIds) : { data: [] },
    grIds.length ? c.from('goods_receipt_batches').select('gr_id,received_cases,qc_result').in('gr_id', grIds) : { data: [] },
    dnIds.length ? c.from('delivery_note_items').select('dn_id, delivery_note_batches(id)').in('dn_id', dnIds) : { data: [] },
    listChainAttachments(orderId).catch(() => []),        // ONE sweep: counters + search index
    buildBusinessTimeline(orderId).catch(() => []),
  ]);
  const siById = {}; (sisQ.data || []).forEach((s) => { siById[s.id] = s; });
  const grById = {}; (grsQ.data || []).forEach((g) => { grById[g.id] = g; });
  const recvByGr = {};
  (grbQ.data || []).forEach((b) => { if (b.qc_result === 'Released') recvByGr[b.gr_id] = (recvByGr[b.gr_id] || 0) + Number(b.received_cases || 0); });
  const batchesByDn = {};
  (dnbQ.data || []).forEach((r) => { batchesByDn[r.dn_id] = (batchesByDn[r.dn_id] || 0) + (r.delivery_note_batches || []).length; });
  const attCount = {}, attNames = {};   // 'doc_type|doc_id' -> count / filenames (search index)
  (atts || []).forEach((a) => {
    const k = a.doc_type + '|' + a.doc_id;
    attCount[k] = (attCount[k] || 0) + 1;
    (attNames[k] = attNames[k] || []).push(String(a.filename || '').toLowerCase());
  });
  const nAtt = (t, id) => attCount[t + '|' + id] || 0;
  const names = (t, id) => attNames[t + '|' + id] || [];

  const piTotal = (fulQ.data || []).reduce((a, r) => a + Number(r.ordered_cases || 0) * Number(r.price_case || 0), 0);
  const withCurrency = (sisQ.data || []).find((s) => s.currency);
  const currency = withCurrency ? withCurrency.currency : 'SAR';
  const grCount = grIds.length;
  const siCount = notes.filter((d) => d.invoice).length;

  // ---- render ---------------------------------------------------------------
  const open = openSet(orderId);
  const isOpen = (k) => open.has(k);

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
    const received = d.goods_receipt ? (recvByGr[d.goods_receipt.id] || 0) : 0;
    const variance = +(shipped - received).toFixed(2);
    const gr = d.goods_receipt ? grById[d.goods_receipt.id] : null;
    const si = d.invoice ? siById[d.invoice.id] : null;
    const subSearch = [
      String(d.dn_number).toLowerCase(), ...names('delivery_note', d.id),
      gr ? String(gr.grn_number).toLowerCase() : '', ...(gr ? names('goods_receipt', gr.id) : []),
      si ? String(si.invoice_number).toLowerCase() : '', ...(si ? names('supplier_invoice', si.id) : []),
    ].join(' ');
    return `<div class="bf-node bf-dn ${isOpen(key) ? 'open' : ''}" data-node="${key}" id="bf-${key}" data-search="${esc(subSearch)}">
      <div class="bf-head" data-toggle="${key}">
        <span class="bf-caret">▸</span><span class="bf-ic">🚚</span>
        <b class="mono">${esc(d.dn_number)}</b> ${statusBadge(d.status)} ${attChip('DN', nAtt('delivery_note', d.id))}
        <span class="bf-meta">${d10(d.dn_date)} · Shipped <b>${qty(shipped)}</b> · Received <b>${qty(received)}</b></span>
        <button class="sc-btn sm ghost bf-open" data-nav="delivery-notes" data-p='${esc(JSON.stringify({ view: 'detail', dnId: d.id }))}'>↗ Open</button>
      </div>
      <div class="bf-body">
        <div class="bf-info">
          ${kv('Date', d10(d.dn_date))}${kv('Status', statusBadge(d.status))}${kv('Shipped Qty', qty(shipped))}
          ${kv('Received Qty', qty(received))}${kv('Variance', variance === 0 ? '0' : qty(variance))}${kv('Batches', batchesByDn[d.id] || 0)}
        </div>
        <div class="bf-atts" data-att="delivery_note:${d.id}"></div>
        <div class="bf-children">
          ${grNode(d)}
          ${siNode(d)}
        </div>
      </div></div>`;
  };

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
          <b class="mono">${esc(order.order_number)}</b> ${statusBadge(order.status)} ${attChip('PI', nAtt('purchase_order', order.id))}
          <span class="bf-meta">Purchase Invoice · ${d10(order.order_date)} · ${esc(order.supplier || '')}</span>
          <button class="sc-btn sm ghost bf-open" data-nav="purchase-orders" data-p='${esc(JSON.stringify({ orderId: order.id, mode: 'view' }))}'>↗ Open</button>
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
  // lazy attachment panels: a node's panel (the standard attachments panel —
  // upload, drag & drop, preview, download, versions) mounts once, the first
  // time that node opens; nothing is fetched for closed nodes
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
  const toggle = (key, node) => {
    const on = node.classList.toggle('open');
    if (on) { open.add(key); mountAtts(node); } else open.delete(key);
    saveOpen(orderId, open);
  };
  body.querySelectorAll('[data-toggle]').forEach((h) => h.addEventListener('click', (e) => {
    if (e.target.closest('.bf-open')) return;   // the Open button navigates, never toggles
    toggle(h.dataset.toggle, h.closest('.bf-node'));
  }));
  body.querySelectorAll('.bf-node.open').forEach((n) => mountAtts(n));
  body.querySelectorAll('.bf-open').forEach((b) => b.addEventListener('click', () => {
    closeDrawer();
    if (navigate) navigate(b.dataset.nav, JSON.parse(b.dataset.p || '{}'));
  }));
  body.querySelectorAll('.bf-card').forEach((cEl) => cEl.addEventListener('click', () => {
    const t = body.querySelector('#' + cEl.dataset.scroll);
    if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  // search: document numbers + attachment file names (index built from the
  // single chain sweep — no extra queries while typing)
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
        // reveal where the match lives without changing the remembered state
        n.classList.add('open'); mountAtts(n);
      }
    });
    body.querySelector('.bf-sec').style.display = q && !hits ? 'none' : '';
    noMatch.style.display = q && !hits ? '' : 'none';
    if (!q) body.querySelectorAll('.bf-dn').forEach((n) => n.classList.toggle('open', open.has(n.dataset.node)));
  });
}
