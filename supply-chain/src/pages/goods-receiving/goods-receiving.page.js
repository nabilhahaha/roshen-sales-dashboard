// Warehouse Receiving — list of receipts + the receiving screen.
//
// UX: healthy batches (shelf life ≥ the SKU minimum) are auto-accepted; the
// user only reviews the EXCEPTIONS (below-minimum batches) and decides Accept
// Exception (with reason + approver, audited) or Reject. Received = Delivered
// by default ("Full Delivery"); unticking allows partial quantities.
//
// Fully automatic completion: the receipt POSTS ITSELF the moment the last
// exception is decided and (if any exception was accepted) the approval
// reason + approver are filled — no manual "Confirm" click. Auto-posting is
// only ever triggered by a user action on this screen (a decision click or
// an approval-field change), never by merely opening it. Clean deliveries
// normally never reach this screen pending — they auto-release at DN
// confirmation (autoReleaseIfClean); the one-click "Receive All Healthy
// Items" button remains as a fallback for receipts that a release guard
// (e.g. a disputed over-delivery) left pending. UI ONLY — every decision
// still flows through the same services (setBatchQc /
// recordShelfLifeException / releaseGoodsReceipt): shelf-life math,
// validation gates, audit and inventory posting unchanged.
import { mount, delegate, wire, qsa, qs } from '../../utils/dom.js';
import { esc, qty, today } from '../../utils/format.js';
import { loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { statusBadge } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import {
  listGoodsReceipts, getGoodsReceipt, setBatchQc, releaseGoodsReceipt, recordShelfLifeException,
} from '../../services/goods-receiving/goods-receiving.service.js';
import { renderDocumentChain } from '../../components/related/document-chain.js';
import { renderDocumentShell, openDrawer, closeDrawer } from '../../components/document/document-shell.js';
import { renderDocumentsTab, renderTimelineTab, openBusinessFile } from '../../components/document/document-extras.js';
import { priceIndex } from '../../services/fulfillment/fulfillment.service.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';

const C = { green: '#2FB344', yellow: '#F2C037', red: '#E03131' };

export async function render(root, ctx) {
  const view = (ctx.params && ctx.params.view) || 'list';
  if (view === 'detail' && ctx.params.grId) return renderDetail(root, ctx, ctx.params.grId);
  return renderList(root, ctx);
}

async function renderList(root, ctx) {
  mount(root, loading('Loading goods receipts…'));
  let grs;
  try { grs = await listGoodsReceipts(); }
  catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
  const rows = grs.map((g) => `<tr class="sc-row-link" data-act="open" data-id="${g.id}">
    <td class="mono"><b>${esc(g.grn_number || g.id)}</b></td>
    <td class="mono">${esc((g.delivery_note && g.delivery_note.dn_number) || '')}</td>
    <td class="mono">${esc((g.order && g.order.order_number) || '')}</td>
    <td>${esc(g.warehouse || '')}</td>
    <td>${esc(g.receipt_date || '')}</td>
    <td>${statusBadge(g.status)}</td></tr>`).join('')
    || '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:22px">No warehouse receipts yet. Confirm a delivery from its Delivery Note.</td></tr>';
  mount(root, `
    <div class="sc-card-h"><h3>🏬 Warehouse Receiving</h3><span class="sc-badge none" style="margin-left:8px">${grs.length}</span>
      <div class="sc-spacer"></div><button class="sc-btn sm ghost" data-act="dn">Delivery Notes →</button></div>
    <div class="sc-card"><p style="font-size:12px;color:var(--text-secondary);margin:0 0 10px">Healthy items are accepted automatically — you only review exceptions.</p>
      ${tableWrap(`<table class="sc-table"><thead><tr><th>Receipt #</th><th>Delivery Note</th><th>PI</th><th>Warehouse</th><th>Date</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`)}</div>`);
  delegate(root, {
    dn: () => ctx.navigate('delivery-notes'),
    open: ({ id }) => ctx.navigate('goods-receiving', { view: 'detail', grId: id }),
  });
}

async function renderDetail(root, ctx, grId) {
  mount(root, loading('Loading warehouse receipt…'));
  let gr, skus, prices;
  try {
    gr = await getGoodsReceipt(grId);
    skus = await listSkus();
    prices = await priceIndex(gr.order_id).catch(() => ({}));
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }
  const byRoshen = indexByRoshen(skus), byCode = indexByCode(skus);
  const skuFor = (b) => byRoshen[String(b.roshen_id || '').trim()] || byCode[String(b.item_code || '').trim()] || null;
  const done = ['Released', 'Partially Released', 'Rejected'].includes(gr.status);

  // ---- screen state: one row per batch, healthy items auto-accepted ----
  // decisions: 'accept' (healthy default) · 'accept-exception' · 'reject' · null (exception awaiting review)
  const ROWS = gr.batches.map((b) => {
    const sl = shelfLife(skuFor(b), { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
    const belowMin = !!sl.belowMinimum;
    // Received seeds from the stored value only when it is a real quantity;
    // a stale 0 on a not-yet-released batch falls back to DELIVERED — the
    // "Full Delivery — Received = Delivered" promise. (A zero here once
    // caused a receipt to release with 0 received and post no inventory.)
    const stored = Number(b.received_cases);
    return {
      b, sl, belowMin,
      decision: done ? null : (belowMin ? null : 'accept'),   // healthy → auto-accepted, no action needed
      received: stored > 0 ? stored : Number(b.delivered_cases || 0),
    };
  });
  let FULL_DELIVERY = true;   // Received = Delivered for every line (default)

  // V2 shell: the receiving flow (unchanged) lives in its own tab; documents
  // and the timeline get tabs of their own. HOST is where paint()/paintDone()
  // mount so every existing interaction keeps working verbatim.
  let HOST = null;
  renderDocumentShell(root, {
    icon: '🏬', title: gr.grn_number || 'Warehouse Receipt',
    badges: statusBadge(gr.status),
    headRight: '<button class="sc-btn sm ghost" data-qact="back">← Warehouse Receiving</button>',
    meta: [
      { label: 'PI', value: (gr.order && gr.order.order_number) || '—' },
      { label: 'Delivery Note', value: (gr.delivery_note && gr.delivery_note.dn_number) || '—' },
      { label: 'Warehouse', value: gr.warehouse || '—' },
      { label: 'Receipt Date', value: gr.receipt_date || '—' },
      { label: 'Batches', value: String(gr.batches.length) },
      { label: 'Last Update', value: String(gr.released_at || gr.receipt_date || '').slice(0, 16).replace('T', ' ') || '—' },
    ],
    activeTab: (ctx.params && ctx.params.tab),
    tabs: [
      { id: 'receiving', label: done ? 'Receipt' : 'Receiving', icon: '📦', count: gr.batches.length,
        render: (el) => { HOST = el; done ? paintDone() : paint(); } },
      { id: 'documents', label: 'Documents', icon: '📎', render: (el) => renderDocumentsTab(el, { orderId: gr.order_id, actor: 'goods-receiving' }) },
      { id: 'timeline', label: 'Timeline', icon: '🧭', render: (el) => renderTimelineTab(el, gr.order_id) },
    ],
    actions: [
      { act: 'opendn', label: '🚚 Open Delivery Note' },
      { act: 'openpo', label: '📄 Open PI' },
      { act: 'bizview', label: '📁 Business File' },
      { act: 'related', label: '🔗 Related Documents' },
      { act: 'refresh', label: '↻ Refresh' },
    ],
    onAction: (act) => {
      if (act === 'back') return ctx.navigate('goods-receiving');
      if (act === 'opendn') return gr.delivery_note_id && ctx.navigate('delivery-notes', { view: 'detail', dnId: gr.delivery_note_id });
      if (act === 'openpo') return gr.order_id && ctx.navigate('purchase-orders', { orderId: gr.order_id, mode: 'view' });
      if (act === 'bizview') return openBusinessFile(gr.order_id, (s2, p2) => ctx.navigate(s2, p2));
      if (act === 'related') {
        const body = openDrawer('🔗 Related Documents — ' + (gr.grn_number || 'receipt'), '');
        return renderDocumentChain(body, (s2, p2) => { closeDrawer(); ctx.navigate(s2, p2); }, { orderId: gr.order_id, current: { type: 'goods_receipt', id: gr.id } });
      }
      if (act === 'refresh') return renderDetail(root, ctx, grId);
    },
  });
  // NOTE: execution must fall through to the declarations below — `saving`
  // and the helpers belong to this scope; the shell's quick-action wiring
  // (data-qact) already covers the header back button.

  // ================= completed receipt (read-only) =================
  function paintDone() {
    const root = HOST;   // the receiving tab body — all selectors stay scoped
    const rows = gr.batches.map((b) => `<tr>
      <td class="mono"><b>${esc(b.roshen_id || b.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(b.description || '')}</div></td>
      <td class="mono">${esc(b.batch_no || '—')}</td><td>${esc(b.expiry_date || '—')}</td>
      <td class="num">${qty(b.delivered_cases)}</td><td class="num"><b>${qty(b.received_cases)}</b></td>
      <td>${b.qc_result === 'Released' ? `<span style="color:${C.green};font-weight:700">✅ Accepted</span>` : `<span style="color:${C.red};font-weight:700">❌ Rejected</span>`}</td></tr>`).join('');
    mount(root, `
      <div class="sc-card-h"><h3>🏬 ${esc(gr.grn_number || 'Warehouse Receipt')}</h3><div class="sc-spacer"></div>
        ${statusBadge(gr.status)}<button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Warehouse Receiving</button></div>
      <div class="sc-card"><span class="sc-badge confirmed">Receipt ${esc(gr.status)}</span> — accepted items are in the warehouse; the PI totals are updated.</div>
      <div class="sc-card">${tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th class="num">Delivered</th><th class="num">Received</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table>`)}</div>
      `);
    wire(root, { back: () => ctx.navigate('goods-receiving') });
  }

  // ================= active receiving =================
  function summary() {
    const excs = ROWS.filter((r) => r.belowMin);
    return {
      lines: ROWS.length,
      accepted: ROWS.filter((r) => r.decision === 'accept' || r.decision === 'accept-exception').length,
      exceptions: excs.length,
      unresolved: excs.filter((r) => !r.decision).length,
      rejected: ROWS.filter((r) => r.decision === 'reject').length,
      delivered: ROWS.reduce((a, r) => a + Number(r.b.delivered_cases || 0), 0),
      received: ROWS.reduce((a, r) => a + (r.decision === 'reject' ? 0 : r.received), 0),
    };
  }

  function paint() {
    const root = HOST;   // the receiving tab body — all selectors stay scoped
    const s = summary();
    const excRows = ROWS.filter((r) => r.belowMin);
    const healthy = ROWS.filter((r) => !r.belowMin);
    const anyAcceptedException = excRows.some((r) => r.decision === 'accept-exception');
    const nowLocal = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);

    const tile = (label, value, color) => `<div class="erp-kpi"><div class="k-lbl">${label}</div>
      <div class="k-val" ${color ? `style="color:${color}"` : ''}>${value}</div></div>`;

    const healthyRows = healthy.map((r) => {
      const i = ROWS.indexOf(r);
      return `<tr style="background:rgba(47,179,68,.04)">
        <td class="mono"><b>${esc(r.b.roshen_id || r.b.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc((r.b.description || '').slice(0, 44))}</div></td>
        <td class="mono">${esc(r.b.batch_no || '—')}</td>
        <td>${esc(r.b.expiry_date || '—')}</td>
        <td class="num">${r.sl.remainingPct != null ? `<b style="color:${C.green}">${r.sl.remainingPct}%</b>` : '—'}</td>
        <td class="num">${qty(r.b.delivered_cases)}</td>
        <td class="num">${FULL_DELIVERY ? `<b>${qty(r.received)}</b>` : `<input class="sc-input sm num" data-recv="${i}" type="number" min="0" step="1" value="${esc(String(r.received))}" style="max-width:90px">`}</td>
        <td>${r.decision === 'reject'
          ? `<span style="color:${C.red};font-weight:700">❌ Rejected</span> <button class="sc-btn sm ghost" data-act="unreject" data-id="${i}">undo</button>`
          : `<span style="color:${C.green};font-weight:700">✅ Accepted</span> <button class="sc-btn sm ghost" data-act="rejecthealthy" data-id="${i}" title="e.g. damaged in transit">reject</button>`}</td></tr>`;
    }).join('');

    const excTable = excRows.map((r) => {
      const i = ROWS.indexOf(r);
      const diff = r.sl.remainingPct != null && r.sl.minPct != null ? +(r.sl.minPct - r.sl.remainingPct).toFixed(1) : null;
      const rowColor = r.decision === 'reject' ? 'rgba(224,49,49,.05)' : r.decision === 'accept-exception' ? 'rgba(47,179,68,.05)' : 'rgba(242,192,55,.06)';
      return `<tr style="background:${rowColor}">
        <td class="mono"><b>${esc(r.b.roshen_id || r.b.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc((r.b.description || '').slice(0, 40))}</div></td>
        <td class="mono">${esc(r.b.batch_no || '—')}</td>
        <td>${esc(r.b.expiry_date || '—')}</td>
        <td class="num"><b style="color:${C.red}">${r.sl.remainingPct != null ? r.sl.remainingPct + '%' : 'n/a'}</b></td>
        <td class="num">${r.sl.minPct != null ? r.sl.minPct + '%' : '—'}</td>
        <td class="num" style="color:${C.red}">${diff != null ? '−' + diff + '%' : '—'}</td>
        <td class="num">${FULL_DELIVERY ? qty(r.received) : `<input class="sc-input sm num" data-recv="${i}" type="number" min="0" step="1" value="${esc(String(r.received))}" style="max-width:84px">`}</td>
        <td style="white-space:nowrap">
          <button class="sc-btn sm ${r.decision === 'accept-exception' ? 'green' : 'ghost'}" data-act="exaccept" data-id="${i}">🟡 Accept Exception</button>
          <button class="sc-btn sm ${r.decision === 'reject' ? 'primary' : 'ghost'}" data-act="exreject" data-id="${i}">❌ Reject</button>
        </td></tr>`;
    }).join('');

    const needApproval = anyAcceptedException && !((paint._reason || '').trim() && (paint._by || '').trim());
    mount(root, `
      <div class="sc-card-h"><h3>🏬 ${esc(gr.grn_number || 'Warehouse Receipt')}</h3><div class="sc-spacer"></div>
        <span style="font-size:12px;color:var(--text-secondary)">PI <b class="mono">${esc((gr.order && gr.order.order_number) || '')}</b> · DN <b class="mono">${esc((gr.delivery_note && gr.delivery_note.dn_number) || '')}</b> · ${esc(gr.warehouse || '—')}</span>
        <button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Warehouse Receiving</button></div>

      <div class="erp-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
        ${tile('Total Lines', s.lines)}
        ${tile('Accepted', s.accepted, C.green)}
        ${tile('Exceptions', s.exceptions ? s.unresolved + ' to review' : 0, s.unresolved ? C.yellow : C.green)}
        ${tile('Rejected', s.rejected, s.rejected ? C.red : undefined)}
        ${tile('Total Delivered', qty(s.delivered))}
        ${tile('Total Received', qty(s.received), C.green)}
      </div>

      <div class="sc-card"><div class="sc-card-h">
        <h3 style="color:${C.green}">✅ Healthy Items (${healthy.length})</h3><div class="sc-spacer"></div>
        <label style="font-size:12.5px;color:var(--text-secondary);display:flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" data-el="fulldelivery" ${FULL_DELIVERY ? 'checked' : ''}> Full Delivery — Received = Delivered</label></div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">These batches meet the required shelf life and are accepted automatically — nothing to do here.${FULL_DELIVERY ? '' : ' Adjust the received quantities for partial deliveries.'}</p>
        ${healthy.length ? tableWrap(`<table class="sc-table"><thead><tr><th>Item</th><th>Batch</th><th>Expiry</th><th class="num">Shelf Life</th><th class="num">Delivered</th><th class="num">Received</th><th>Decision</th></tr></thead><tbody>${healthyRows}</tbody></table>`)
          : '<p style="font-size:12.5px;color:var(--text-muted);margin:0">No healthy batches on this delivery.</p>'}
      </div>

      ${excRows.length ? `<div class="sc-card" id="exceptions" style="border-left:3px solid ${C.yellow}">
        <div class="sc-card-h"><h3 style="color:${C.yellow}">🟡 Exceptions — shelf life below minimum (${excRows.length})</h3><div class="sc-spacer"></div>
          <span style="font-size:12px;color:var(--text-secondary)">${s.unresolved ? `<b>${s.unresolved}</b> awaiting your decision` : '<b style="color:' + C.green + '">all resolved</b>'}</span></div>
        ${tableWrap(`<table class="sc-table"><thead><tr><th>SKU</th><th>Batch</th><th>Expiry Date</th><th class="num">Remaining %</th><th class="num">Required %</th><th class="num">Difference</th><th class="num">Received</th><th>Decision</th></tr></thead><tbody>${excTable}</tbody></table>`)}
        ${anyAcceptedException ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--border-light)">
          <p style="font-size:12px;color:var(--text-secondary);margin:0 0 8px"><b>Exception approval</b> — required for the accepted exception(s); stored permanently in the audit trail.</p>
          <div class="sc-form-grid">
            <div class="sc-field"><label>Exception Reason *</label><input data-el="ex-reason" class="sc-input" placeholder="e.g. urgent stock need — fast rotation" value="${esc(paint._reason || '')}"></div>
            <div class="sc-field"><label>Approved By *</label><input data-el="ex-by" class="sc-input" placeholder="Name of the approver" value="${esc(paint._by || '')}"></div>
            <div class="sc-field"><label>Approval Date &amp; Time</label><input data-el="ex-at" class="sc-input" type="datetime-local" value="${esc(paint._at || nowLocal)}"></div>
          </div></div>` : ''}
      </div>` : ''}

      <div class="sc-card" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${excRows.length === 0
          ? `<button class="sc-btn green" data-act="confirm">✅ Receive All Healthy Items</button>
             <span style="font-size:12px;color:var(--text-secondary)">Accepted items post to the warehouse and update the PI automatically.</span>`
          : `${s.unresolved ? `<button class="sc-btn" style="background:${C.yellow};color:#1a1a1a" data-act="gotoexc">🟡 Review Exceptions (${s.unresolved})</button>` : ''}
             <span style="font-size:12px;color:var(--text-secondary)">${s.unresolved
               ? '⚡ The receipt completes automatically once every exception is decided — no confirmation click needed. Reject any damaged healthy line first.'
               : needApproval
                 ? '⚡ Enter the exception reason and approver above — the receipt then posts automatically.'
                 : 'Posting the warehouse receipt…'}</span>`}
      </div>`);

    // ---- interactions (state only — no service calls until confirm) ----
    const keepApproval = () => {
      const v = (sel) => { const n = qs(`[data-el="${sel}"]`, root); return n ? n.value : ''; };
      paint._reason = v('ex-reason'); paint._by = v('ex-by'); paint._at = v('ex-at');
    };
    const full = qs('[data-el="fulldelivery"]', root);
    if (full) full.addEventListener('change', () => {
      keepApproval();
      FULL_DELIVERY = full.checked;
      if (FULL_DELIVERY) ROWS.forEach((r) => { r.received = Number(r.b.delivered_cases || 0); });
      paint();
    });
    qsa('[data-recv]', root).forEach((inp) => inp.addEventListener('change', () => {
      const r = ROWS[+inp.dataset.recv];
      r.received = Math.max(0, Number(inp.value || 0));
      keepApproval(); paint();
    }));
    // approval fields: filling reason + approver is the FINAL user action on an
    // accepted exception — the receipt posts itself as soon as both are set
    ['ex-reason', 'ex-by', 'ex-at'].forEach((sel) => {
      const inp = qs(`[data-el="${sel}"]`, root);
      if (inp) inp.addEventListener('change', () => { keepApproval(); maybeAutoConfirm(); });
    });
    wire(root, {
      back: () => ctx.navigate('goods-receiving'),
      gotoexc: () => { const el = qs('#exceptions', root); if (el) el.scrollIntoView({ behavior: 'smooth' }); },
      exaccept: (d) => { keepApproval(); ROWS[+d.id].decision = 'accept-exception'; paint(); maybeAutoConfirm(); },
      exreject: (d) => { keepApproval(); ROWS[+d.id].decision = 'reject'; paint(); maybeAutoConfirm(); },
      rejecthealthy: (d) => { keepApproval(); ROWS[+d.id].decision = 'reject'; paint(); },
      unreject: (d) => { keepApproval(); ROWS[+d.id].decision = 'accept'; paint(); },
      confirm: () => confirmReceipt(),
    });
  }

  // ---- automatic completion: fires only from user actions above (a decision
  // click or an approval-field change) — never on merely opening the screen ----
  function maybeAutoConfirm() {
    const root = HOST;
    if (saving) return;
    if (summary().unresolved > 0) return;                 // exceptions still awaiting a decision
    const excAccepted = ROWS.some((r) => r.belowMin && r.decision === 'accept-exception');
    if (excAccepted) {
      const v = (sel) => { const n = qs(`[data-el="${sel}"]`, root); return n ? n.value.trim() : ''; };
      if (!v('ex-reason') || !v('ex-by')) return;         // audited approval not complete yet
    }
    toast('All exceptions resolved — completing the warehouse receipt…', 'info');
    confirmReceipt();
  }

  // ---- confirm: identical service flow as before (UI is the only change) ----
  let saving = false;
  async function confirmReceipt() {
    const root = HOST;
    if (saving) return;
    const s = summary();
    if (s.unresolved) return toast('Resolve every exception first', 'err');
    const excAccepted = ROWS.filter((r) => r.belowMin && r.decision === 'accept-exception');
    const v = (sel) => { const n = qs(`[data-el="${sel}"]`, root); return n ? n.value.trim() : ''; };
    const approval = { reason: v('ex-reason'), by: v('ex-by'), at: v('ex-at') };
    if (excAccepted.length) {
      if (!approval.reason) return toast('Enter the exception reason', 'err');
      if (!approval.by) return toast('Enter who approved the exception', 'err');
    }
    // accepted batches MUST carry a received quantity — a receipt can never
    // post 0 cases for accepted goods (reject the batches instead)
    if (s.received === 0 && s.accepted > 0) {
      return toast('Nothing would be received — enter the received quantities (or reject the batches). The receipt was NOT posted.', 'err');
    }
    if (s.received === 0 && !confirm('Every batch is rejected — nothing will be received into the warehouse. Continue?')) return;
    saving = true;
    qsa('button', root).forEach((b) => (b.disabled = true));
    try {
      for (const r of ROWS) {
        const decision = r.decision === 'reject' ? 'Rejected' : 'Released';
        const received = decision === 'Released' ? r.received : 0;
        await setBatchQc(r.b.id, { qc_result: decision, received_cases: received, rejected_cases: decision === 'Rejected' ? r.b.delivered_cases : 0 });
        if (r.belowMin) {
          await recordShelfLifeException({
            order_id: gr.order_id, dn_id: gr.delivery_note_id, dn_batch_id: r.b.dn_batch_id,
            item_code: r.b.item_code, roshen_id: r.b.roshen_id, batch_no: r.b.batch_no, expiry_date: r.b.expiry_date,
            required_pct: r.sl.minPct, remaining_pct: r.sl.remainingPct,
            decision: decision === 'Released' ? 'Accept Exception' : 'Reject Item',
            reason: decision === 'Released' ? approval.reason : 'Rejected at warehouse receiving',
            decided_by: decision === 'Released' ? approval.by : 'goods-receiving',
            decided_at: decision === 'Released' && approval.at ? new Date(approval.at).toISOString() : undefined,
          });
        }
      }
      const res = await releaseGoodsReceipt(gr.id, { warehouse: gr.warehouse, costByKey: prices, releasedBy: approval.by || 'goods-receiving' });
      toast(`Receipt ${res.status} — ${res.released} accepted, ${res.rejected} rejected`, 'ok');
      ctx.navigate('goods-receiving', { view: 'detail', grId: gr.id });
    } catch (e) {
      saving = false;
      qsa('button', root).forEach((b) => (b.disabled = false));
      toast('Receiving failed: ' + (e.message || e), 'err');
    }
  }
}
