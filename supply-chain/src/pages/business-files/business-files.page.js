// Business Files — the permanent, full-page home of every purchase order's
// Business File (nav: Procurement → Business Files).
//
//   #business-files                → master list (every order's file: open AND
//                                    completed — same single overview
//                                    implementation as Open Orders)
//   #business-files/KS-393-2026    → the Business File workspace of that PO
//
// The workspace hosts the EXISTING Business File renderer (components/document/
// business-file.js) — hierarchy, sticky summary, search, expand/collapse,
// lazy attachments, quick actions, variance badges, timeline — unchanged.
// This page only gives it a full-width permanent home plus header actions
// (Export Excel · Export PDF · Print · Refresh · Search) and a tab strip that
// is ready to host future tabs (Received Batches, Freshness, Exceptions,
// Audit Log, Reports, Batch Analysis) without another redesign.
import { mount, delegate } from '../../utils/dom.js';
import { esc, qty } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { getClient } from '../../services/supabase/client.js';
import { openOrdersOverview } from '../../services/fulfillment/fulfillment.service.js';
import { exportOrderBusinessFile } from '../../services/export/business-export.service.js';
import { renderBusinessFile } from '../../components/document/business-file.js';
import { renderSummaryTab } from './summary.tab.js';
import { BIZ_VARIANT } from '../../models/business-status.js';

const slugOf = (orderNumber) => String(orderNumber || '').replace(/[^\w-]+/g, '-');
const bizBadge = (s) => `<span class="sc-badge ${BIZ_VARIANT[s] || 'none'}">${esc(s)}</span>`;

// future tabs register here — one entry (id, icon, label, render) per tab,
// no layout changes needed: Received Batches · Freshness · Exceptions ·
// Audit Log · Reports · Batch Analysis. Each tab renders LAZILY on first
// activation and keeps its DOM when switching back.
const TABS = [
  { id: 'chain', icon: '📂', label: 'Document Chain' },
  { id: 'summary', icon: '📊', label: 'Summary' },
];

export async function render(root, ctx) {
  const params = ctx.params || {};
  let orderId = params.orderId ? +params.orderId : null;

  // deep link #business-files/<po-number-slug> → resolve to the order id
  if (!orderId && params.path) {
    const { data } = await getClient().from('supply_orders')
      .select('id,order_number').neq('status', 'Draft').range(0, 4999);
    const hit = (data || []).find((o) => slugOf(o.order_number) === slugOf(params.path));
    if (hit) orderId = hit.id;
    else return mount(root, emptyState('📁', `No Business File found for “${esc(params.path)}”.`));
  }

  if (orderId) return workspace(root, ctx, orderId);
  return masterList(root, ctx);
}

// ---- master list — every order's Business File, like Open Orders -----------
async function masterList(root, ctx) {
  mount(root, loading('Loading business files…'));
  let orders;
  try { orders = await openOrdersOverview({ includeClosed: true }); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const state = { q: '', status: '' };
  const statuses = [...new Set(orders.map((o) => o.business_status))].sort();

  paint();
  delegate(root, {
    openbf: ({ id }) => ctx.navigate('business-files', { orderId: +id }),
  });

  function paint() {
    const q = state.q.toLowerCase();
    const rows = orders.filter((o) =>
      (!q || [o.order_number, o.supplier, o.business_status].some((v) => String(v || '').toLowerCase().includes(q)))
      && (!state.status || o.business_status === state.status));
    mount(root, `
      <div class="sc-card-h"><h3>📁 Business Files</h3>
        <span class="sc-badge none" style="margin-left:8px">${rows.length}</span>
        <div class="sc-spacer"></div>
        <span style="font-size:12px;color:var(--text-secondary)">one complete document file per purchase order — PI, delivery notes, receipts, invoices, attachments, timeline</span></div>
      <div class="sc-card">
        <div class="bfp-bar">
          <input class="sc-input sm" data-el="q" placeholder="🔎 PO number · supplier · status…" value="${esc(state.q)}" style="min-width:240px;flex:1">
          <select class="sc-select sm" data-el="status"><option value="">All statuses</option>
            ${statuses.map((s) => `<option ${state.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
        </div>
        ${tableWrap(`<table class="sc-table"><thead><tr>
          <th>PO Number</th><th>Supplier</th><th>Order Date</th>
          <th class="num">Ordered Qty</th><th class="num">Shipped Qty</th><th class="num">Delivered Qty</th><th class="num">Remaining Qty</th>
          <th>Status</th><th></th></tr></thead><tbody>
          ${rows.map((o) => `<tr class="sc-row-link" data-act="openbf" data-id="${o.id}">
            <td class="mono"><b>${esc(o.order_number)}</b></td>
            <td>${esc(o.supplier || '')}</td>
            <td style="font-size:11.5px">${esc(o.order_date || '')}</td>
            <td class="num">${qty(o.ordered_cases)}</td><td class="num">${qty(o.shipped_cases)}</td>
            <td class="num">${qty(o.delivered_cases)}</td><td class="num"><b>${qty(o.remaining_cases)}</b></td>
            <td style="white-space:nowrap">${bizBadge(o.business_status)}</td>
            <td><button class="sc-btn sm ghost" data-act="openbf" data-id="${o.id}">📁 Open</button></td></tr>`).join('')
          || '<tr><td colspan="9" style="text-align:center;color:var(--text-muted);padding:22px">No business files match the current filters.</td></tr>'}
        </tbody></table>`)}
      </div>`);
    root.querySelectorAll('[data-el="q"],[data-el="status"]').forEach((n) => {
      n.addEventListener(n.tagName === 'SELECT' ? 'change' : 'input', () => {
        state[n.dataset.el] = n.value;
        const focus = n.dataset.el;
        paint();
        const again = root.querySelector(`[data-el="${focus}"]`);
        if (again && focus === 'q') { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
      });
    });
  }
}

// ---- workspace — one order's Business File, full width ----------------------
async function workspace(root, ctx, orderId) {
  mount(root, `
    <div class="sc-card-h bfp-head">
      <button class="sc-btn sm ghost" data-el="back">← All Business Files</button>
      <h3 data-el="bftitle">📁 Business File</h3>
      <div class="sc-spacer"></div>
      <input class="sc-input sm bfp-search" data-el="hsearch" placeholder="🔎 Search the file…">
      <button class="sc-btn sm ghost" data-el="xls">📊 Export Excel</button>
      <button class="sc-btn sm ghost" data-el="pdf">📄 Export PDF</button>
      <button class="sc-btn sm ghost" data-el="print">🖨 Print</button>
      <button class="sc-btn sm ghost" data-el="refresh">⟳ Refresh</button>
    </div>
    <div class="doc-tabs bfp-tabs">${TABS.map((t, i) => `<button class="doc-tab${i === 0 ? ' active' : ''}" data-tab="${t.id}">${t.icon} ${t.label}</button>`).join('')}</div>
    <div class="bfp-body" data-el="body"></div>`);

  const el = (k) => root.querySelector(`[data-el="${k}"]`);
  el('back').addEventListener('click', () => ctx.navigate('business-files'));
  const nav = (s, p) => ctx.navigate(s, p);
  const body = el('body');

  // one host per tab — rendered LAZILY on first activation, DOM kept when
  // switching back (so the chain's expand state and the summary's filters
  // both survive tab switches)
  let active = 'chain';
  let handle = null; // Document Chain handle (order info + print document)
  const hosts = {}, rendered = new Set();
  const hostOf = (id) => {
    if (!hosts[id]) { const d = document.createElement('div'); d.dataset.tabhost = id; body.appendChild(d); hosts[id] = d; }
    return hosts[id];
  };
  const renderTab = async (id) => {
    const host = hostOf(id);
    if (id === 'chain') {
      handle = await renderBusinessFile(host, orderId, nav);
      if (handle && handle.order) {
        el('bftitle').textContent = `📁 Business File — ${handle.order.order_number}`;
        // refine the address to the permanent deep link of this file
        try { history.replaceState(null, '', '#business-files/' + slugOf(handle.order.order_number)); } catch (e) { /* noop */ }
      }
    } else if (id === 'summary') await renderSummaryTab(host, { orderId, navigate: nav });
  };
  async function activate(id) {
    active = id;
    root.querySelectorAll('.bfp-tabs .doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    TABS.forEach((t) => { if (hosts[t.id]) hosts[t.id].style.display = t.id === id ? '' : 'none'; });
    hostOf(id).style.display = '';
    if (!rendered.has(id)) { rendered.add(id); await renderTab(id); }
  }
  root.querySelectorAll('.bfp-tabs .doc-tab').forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));
  await activate('chain');

  // header search drives the ACTIVE tab's own search box — one implementation
  const hs = el('hsearch');
  hs.oninput = () => {
    const target = active === 'chain'
      ? hostOf('chain').querySelector('[data-el="bfsearch"]')
      : hostOf('summary').querySelector('[data-f="dn"]');
    if (target) { target.value = hs.value; target.dispatchEvent(new Event('input')); }
  };

  el('refresh').addEventListener('click', async () => {
    rendered.add(active);
    await renderTab(active);
    toast(active === 'chain' ? 'Business File refreshed' : 'Summary refreshed', 'ok');
  });
  el('xls').addEventListener('click', async () => {
    try { await exportOrderBusinessFile(orderId); toast('Business File exported', 'ok'); }
    catch (e) { toast(e.message || String(e), 'err'); }
  });
  el('pdf').addEventListener('click', () => { if (handle) handle.print({ pdf: true }); });
  el('print').addEventListener('click', () => { if (handle) handle.print({ pdf: false }); });
}
