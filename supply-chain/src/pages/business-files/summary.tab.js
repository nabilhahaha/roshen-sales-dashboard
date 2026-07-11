// Business File — SUMMARY tab (management quick review, beside Document Chain).
//
// One expandable card per Purchase Invoice. The PI cards come from the
// existing proforma_invoices documents of the order; when the order has no
// separate PI documents (the common case today — the order itself carries the
// Purchase Invoice, exactly like the Document Chain's PI node) ONE card
// represents it. Unlimited PI cards are supported by construction: the module
// renders whatever list the existing service returns, each card independently
// expandable and LAZY (its table, attachments and freshness data load on
// first expand only).
//
// NOTE the schema has no delivery_note → PI link (delivery notes belong to
// the ORDER), so delivery notes are shown under the order's primary PI card;
// dnsOf() below is the single place to change when that relationship exists.
//
// One row = one delivery note, showing ONLY its own documents: its own
// supplier invoice, its own goods receipt (relationships come from the
// existing listDeliveryNotes joins) and ONLY its own attachments (its DN
// file + its invoice's files + its receipt's files) from the existing
// chain-wide attachment sweep. Preview / download / upload / drag & drop /
// version history reuse the standard attachment components unchanged.
import { esc, qty, money, today } from '../../utils/format.js';
import { stampCardLabels } from '../../utils/dom.js';
import { getClient } from '../../services/supabase/client.js';
import { listDeliveryNotes } from '../../services/delivery-note/delivery-note.service.js';
import { listChainAttachments, attachmentUrl, canPreview } from '../../services/attachments/attachments.service.js';
import { attachmentsPanel, previewAttachment } from '../../components/attachments/attachments-panel.js';
import { shelfLife } from '../../models/shelf-life.js';
import { toast } from '../../components/notifications/toast.js';
import { t } from '../../i18n/i18n.js';

// display vocabulary over the SAME data the Document Chain shows — no new
// business rules, just one badge per delivery-note row
const rowStatus = (gr, si, variance) => {
  const released = gr && ['Released', 'Partially Released'].includes(gr.status);
  if (!released) return { label: 'Waiting Goods Receipt', cls: 'none' };
  if (gr.status === 'Partially Released') return { label: 'Partially Received', cls: 'pi' };
  if (variance !== 0) return { label: 'Variance', cls: 'closed' };
  if (!si) return { label: 'Waiting Invoice', cls: 'pi' };
  if (si.status === 'Matched') return { label: 'Completed', cls: 'confirmed' };
  return { label: 'Balanced', cls: 'confirmed' };
};
const STATUSES = ['Balanced', 'Waiting Invoice', 'Waiting Goods Receipt', 'Partially Received', 'Completed', 'Variance'];
const freshColor = (p) => (p == null ? null : p >= 90 ? '#2FB344' : p >= 80 ? '#F2C037' : p >= 70 ? '#F76707' : '#E03131');
const d10 = (t) => String(t || '').slice(0, 10);

// three SEPARATE attachment columns — every attachment belongs to exactly one
// document: the PI's files (shared for the whole PI), the row's own delivery
// note files, the row's own supplier invoice files. Never merged, never
// borrowed from another DN or invoice.
const COLS = ['Delivery Note No.', 'Delivery Date', 'Supplier Invoice No.', 'Supplier Invoice Date',
  'Goods Receipt No.', 'Goods Receipt Date', 'Shipped Qty', 'Received Qty', 'Variance', 'Freshness %',
  'PI Attachment', 'DN Attachment', 'Invoice Attachment', 'Status'];

export async function renderSummaryTab(el, { orderId }) {
  el.innerHTML = '<div class="sk-page-head"><span class="sc-spin" style="width:13px;height:13px"></span> <span>Loading the summary…</span></div>';
  const c = getClient();

  // ---- wave 1: the order, its delivery notes, its PI documents --------------
  const [{ data: order }, dns, { data: pis }, { data: ful }] = await Promise.all([
    c.from('supply_orders').select('id,order_number,order_date,supplier,status').eq('id', orderId).single(),
    listDeliveryNotes(orderId),
    c.from('proforma_invoices').select('id,pi_number,pi_date,supplier,status').eq('order_id', orderId).order('id'),
    c.from('po_line_fulfillment').select('ordered_cases,received_cases,price_case').eq('order_id', orderId),
  ]);
  const notes = (dns || []).slice().sort((a, b) => String(a.dn_number).localeCompare(String(b.dn_number)));
  const agg = {
    ordered: (ful || []).reduce((a, r) => a + Number(r.ordered_cases || 0), 0),
    received: (ful || []).reduce((a, r) => a + Number(r.received_cases || 0), 0),
    value: (ful || []).reduce((a, r) => a + Number(r.ordered_cases || 0) * Number(r.price_case || 0), 0),
    shipped: notes.reduce((a, d) => a + Number(d.total_cartons || 0), 0),
  };
  agg.remaining = +Math.max(0, agg.ordered - agg.received).toFixed(2);

  // one card per PI document; the order itself is the Purchase Invoice when
  // no separate PI documents exist (same as the Document Chain's PI node)
  const cards = (pis && pis.length)
    ? pis.map((p) => ({ key: 'pi' + p.id, number: p.pi_number, date: p.pi_date, supplier: p.supplier || order.supplier, status: p.status || 'Imported', synthetic: false }))
    : [{ key: 'order', number: order.order_number, date: order.order_date, supplier: order.supplier, status: order.status, synthetic: true }];
  // no dn.pi_id in the schema → notes live under the order's primary PI card
  const dnsOf = (card, idx) => (idx === 0 ? notes : []);

  // ---- wave 2 (LAZY): loaded once, on the first card expand ------------------
  let detailP = null;
  const loadDetail = () => {
    detailP = detailP || (async () => {
      const grIds = notes.map((d) => d.goods_receipt && d.goods_receipt.id).filter(Boolean);
      const siIds = notes.map((d) => d.invoice && d.invoice.id).filter(Boolean);
      const [grsQ, sisQ, grbQ, atts] = await Promise.all([
        grIds.length ? c.from('goods_receipts').select('id,grn_number,status,released_at').in('id', grIds) : { data: [] },
        siIds.length ? c.from('supplier_invoices').select('id,invoice_number,invoice_date,status,created_at').in('id', siIds) : { data: [] },
        grIds.length ? c.from('goods_receipt_batches').select('gr_id,batch_no,received_cases,qc_result,expiry_date,manufacturing_date,sku_id').in('gr_id', grIds).range(0, 4999) : { data: [] },
        listChainAttachments(orderId).catch(() => []),
      ]);
      const skuIds = [...new Set((grbQ.data || []).map((b) => b.sku_id).filter(Boolean))];
      const { data: skus } = skuIds.length ? await c.from('sku_master')
        .select('id,shelf_life_value,shelf_life_unit,min_remaining_shelf_life_pct').in('id', skuIds) : { data: [] };
      const skuById = {}; (skus || []).forEach((s) => { skuById[s.id] = s; });
      const grById = {}; (grsQ.data || []).forEach((g) => { grById[g.id] = g; });
      const siById = {}; (sisQ.data || []).forEach((s) => { siById[s.id] = s; });
      const recvByGr = {}, batchesByGr = {}, freshByGr = {};
      const asOf = today();
      (grbQ.data || []).forEach((b) => {
        if (b.qc_result !== 'Released') return;
        recvByGr[b.gr_id] = (recvByGr[b.gr_id] || 0) + Number(b.received_cases || 0);
        (batchesByGr[b.gr_id] = batchesByGr[b.gr_id] || []).push(String(b.batch_no || '').toLowerCase());
        const sl = shelfLife(skuById[b.sku_id] || null, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, asOf);
        if (sl.remainingPct != null) (freshByGr[b.gr_id] = freshByGr[b.gr_id] || []).push(sl.remainingPct);
      });
      const attsByKey = {};
      (atts || []).forEach((a) => { (attsByKey[a.doc_type + '|' + a.doc_id] = attsByKey[a.doc_type + '|' + a.doc_id] || []).push(a); });
      // the PI's own files — shared for the entire PI (the order carries the
      // Purchase Invoice document, as in the Document Chain's PI node)
      const piFiles = attsByKey['purchase_order|' + orderId] || [];
      // rows: one per delivery note, each bound ONLY to its own documents —
      // its own DN files and its own invoice's files, never another row's
      const rows = notes.map((d) => {
        const gr = d.goods_receipt ? grById[d.goods_receipt.id] : null;
        const si = d.invoice ? siById[d.invoice.id] : null;
        const shipped = Number(d.total_cartons || 0);
        const received = gr ? +(recvByGr[gr.id] || 0).toFixed(2) : 0;
        const variance = +(shipped - received).toFixed(2);
        const fresh = gr && (freshByGr[gr.id] || []).length
          ? +((freshByGr[gr.id].reduce((a, b) => a + b, 0)) / freshByGr[gr.id].length).toFixed(1) : null;
        const st = rowStatus(gr, si, variance);
        return {
          dn_id: d.id, gr_id: gr ? gr.id : null, si_id: si ? si.id : null,
          dn: d.dn_number, dnDate: d10(d.dn_date),
          inv: si ? si.invoice_number : '', invDate: si ? d10(si.invoice_date || si.created_at) : '',
          grn: gr ? gr.grn_number : '', grDate: gr ? d10(gr.released_at) : '',
          shipped, received, variance, fresh,
          piFiles,
          dnFiles: attsByKey['delivery_note|' + d.id] || [],
          invFiles: si ? (attsByKey['supplier_invoice|' + si.id] || []) : [],
          batches: gr ? (batchesByGr[gr.id] || []) : [],
          status: st.label, statusCls: st.cls,
        };
      });
      return { rows };
    })();
    return detailP;
  };

  // ---- shell ------------------------------------------------------------------
  const stat = (l, v) => `<span class="bf-stat"><span>${l}</span><b>${v}</b></span>`;
  el.innerHTML = `
    <div class="sum-cards">${cards.map((card, i) => `
      <div class="bf-node sum-pi" data-pi="${card.key}">
        <div class="bf-head" data-pit="${card.key}">
          <span class="bf-caret">▸</span><span class="bf-ic">📋</span>
          <b class="mono">PI ${esc(card.number)}</b>
          <span class="sc-badge ${card.status === 'Closed' ? 'closed' : 'pi'}">${esc(card.status)}</span>
          <span class="bf-meta">${esc(card.supplier || '—')} · ${d10(card.date)}</span>
          <span class="bf-stats">
            ${i === 0 ? `${stat('Ordered', qty(agg.ordered))}${stat('Shipped', qty(agg.shipped))}${stat('Received', qty(agg.received))}${stat('Remaining', qty(agg.remaining))}${stat('Value', money(agg.value))}` : ''}
          </span>
        </div>
        <div class="bf-body"><div data-pibody="${card.key}"></div></div>
      </div>`).join('')}
    </div>`;

  const openPi = new Set();
  el.querySelectorAll('[data-pit]').forEach((h) => h.addEventListener('click', async () => {
    const key = h.dataset.pit;
    const node = el.querySelector(`[data-pi="${key}"]`);
    const on = node.classList.toggle('open');
    if (!on) { openPi.delete(key); return; }
    openPi.add(key);
    const host = el.querySelector(`[data-pibody="${key}"]`);
    if (host.dataset.ready) return;
    host.dataset.ready = '1';
    host.innerHTML = '<div class="sk-page-head"><span class="sc-spin" style="width:13px;height:13px"></span> <span>Loading delivery notes…</span></div>';
    const idx = cards.findIndex((cd) => cd.key === key);
    const list = dnsOf(cards[idx], idx);
    if (!list.length) { host.innerHTML = '<p style="font-size:12px;color:var(--text-muted);margin:6px 0">No delivery notes are linked to this Purchase Invoice yet.</p>'; return; }
    const { rows } = await loadDetail();
    mountTable(host, rows.filter((r) => list.some((d) => d.id === r.dn_id)));
  }));
  // the primary card opens by default — it carries the delivery-note table
  const first = el.querySelector('[data-pit]');
  if (first) first.click();

  // ---- the summary table with filters + exports --------------------------------
  function mountTable(host, allRows) {
    const state = { dn: '', inv: '', batch: '', att: '', status: '', fresh: '', from: '', to: '' };
    host.innerHTML = `
      <div class="sum-bar">
        <input class="sc-input sm" data-f="dn" placeholder="🔎 Delivery note…">
        <input class="sc-input sm" data-f="inv" placeholder="🔎 Invoice…">
        <input class="sc-input sm" data-f="batch" placeholder="🔎 Batch…">
        <input class="sc-input sm" data-f="att" placeholder="🔎 Attachment name…">
        <select class="sc-select sm" data-f="status"><option value="">Status</option>${STATUSES.map((s) => `<option>${s}</option>`).join('')}</select>
        <select class="sc-select sm" data-f="fresh"><option value="">Freshness %</option>
          <option value="90">≥ 90%</option><option value="80">≥ 80%</option><option value="70">≥ 70%</option><option value="-70">Below 70%</option></select>
        <label class="sum-datef">From <input type="date" class="sc-input sm" data-f="from"></label>
        <label class="sum-datef">To <input type="date" class="sc-input sm" data-f="to"></label>
        <span class="sc-spacer"></span>
        <button class="sc-btn sm ghost" data-sum="xls">📊 Export Excel</button>
        <button class="sc-btn sm ghost" data-sum="pdf">🖨 Export PDF</button>
      </div>
      <div data-el="sumgrid"></div>`;
    const grid = host.querySelector('[data-el="sumgrid"]');

    const filtered = () => allRows.filter((r) =>
      (!state.dn || r.dn.toLowerCase().includes(state.dn))
      && (!state.inv || r.inv.toLowerCase().includes(state.inv))
      && (!state.batch || r.batches.some((b) => b.includes(state.batch)))
      && (!state.att || [...r.piFiles, ...r.dnFiles, ...r.invFiles].some((f) => String(f.filename || '').toLowerCase().includes(state.att)))
      && (!state.status || r.status === state.status)
      && (!state.fresh || (r.fresh != null && (state.fresh === '-70' ? r.fresh < 70 : r.fresh >= +state.fresh)))
      && (!state.from || r.dnDate >= state.from) && (!state.to || r.dnDate <= state.to));

    const filesOf = (r, kind) => (kind === 'pi' ? r.piFiles : kind === 'dn' ? r.dnFiles : r.invFiles);
    const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round((b || 0) / 1024)) + ' KB');
    // one attachment box per DOCUMENT — its own collection only, never merged
    const attCell = (r, kind) => {
      if (kind === 'inv' && !r.si_id) return '<span class="sum-noatt">—</span>';
      const files = filesOf(r, kind);
      if (!files.length) return `<div class="sum-att sum-att-empty"><span class="sum-noatt">No Attachment</span>
        <button class="bf-qbtn" data-up="${r.dn_id}:${kind}" title="Upload a file to this document">📤</button></div>`;
      return `<div class="sum-att">
        <button class="sum-att-h" data-attog>📎 ${files.length} File${files.length > 1 ? 's' : ''}</button>
        <div class="sum-att-list">
          ${files.map((f, i) => `<div class="sum-att-row">
            <button class="sum-att-name" data-prev="${r.dn_id}:${kind}:${i}" title="${esc(f.filename || '')}">${canPreview(f) ? '👁' : '📄'} ${esc(String(f.filename || '').slice(0, 30))}</button>
            <a class="bf-qbtn" href="${esc(attachmentUrl(f))}?download=${encodeURIComponent(f.filename || 'file')}" download="${esc(f.filename || '')}" title="Download">⬇</a>
            <span class="sum-att-meta">${fmtSize(f.byte_size)} · ${d10(f.created_at)} · ${esc(f.uploaded_by || '—')}${f.revision > 1 ? ' · v' + f.revision : ''}</span>
          </div>`).join('')}
          <button class="sum-att-manage" data-up="${r.dn_id}:${kind}">⚙ Manage — upload · drag &amp; drop · versions</button>
        </div></div>`;
    };
    const freshCell = (p) => (p == null ? '—' : `<span class="rb-fresh" style="--c:${freshColor(p)}"><b>${p}%</b></span>`);

    function paint() {
      const rows = filtered();
      grid.innerHTML = `<div class="sc-table-wrap"><table class="sc-table sum-table sc-cardify"><thead><tr>
        ${COLS.map((h, i) => `<th class="${i >= 6 && i <= 9 ? 'num' : ''}">${h}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((r) => `<tr data-row="${r.dn_id}">
          <td class="mono"><b>${esc(r.dn)}</b></td><td>${esc(r.dnDate || '—')}</td>
          <td class="mono">${esc(r.inv || '—')}</td><td>${esc(r.invDate || '—')}</td>
          <td class="mono">${esc(r.grn || '—')}</td><td>${esc(r.grDate || '—')}</td>
          <td class="num">${qty(r.shipped)}</td><td class="num">${qty(r.received)}</td>
          <td class="num ${r.variance !== 0 ? 'sum-bad' : ''}">${qty(r.variance)}</td>
          <td>${freshCell(r.fresh)}</td>
          <td>${attCell(r, 'pi')}</td>
          <td>${attCell(r, 'dn')}</td>
          <td>${attCell(r, 'inv')}</td>
          <td><span class="sc-badge ${r.statusCls}">${esc(r.status)}</span></td></tr>
          <tr class="sum-manage-row" data-managerow="${r.dn_id}" style="display:none"><td colspan="${COLS.length}"></td></tr>`).join('')
        || `<tr><td colspan="${COLS.length}" style="text-align:center;color:var(--text-muted);padding:18px">No delivery notes match the current filters.</td></tr>`}
      </tbody></table></div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">${rows.length} of ${allRows.length} delivery note(s) · Shipped ${qty(rows.reduce((a, r) => a + r.shipped, 0))} · Received ${qty(rows.reduce((a, r) => a + r.received, 0))}</p>`;

      stampCardLabels(grid);
      grid.querySelectorAll('[data-attog]').forEach((b) => b.addEventListener('click', () => b.closest('.sum-att').classList.toggle('open')));
      grid.querySelectorAll('[data-prev]').forEach((b) => b.addEventListener('click', () => {
        const [dnId, kind, i] = b.dataset.prev.split(':');
        const r = allRows.find((x) => x.dn_id === +dnId);
        const files = filesOf(r, kind);
        const f = files[+i];
        if (canPreview(f)) {
          const previewable = files.filter((a) => canPreview(a));
          previewAttachment(f, { list: previewable, index: previewable.indexOf(f) });
        } else window.open(attachmentUrl(f), '_blank');
      }));
      // 📤 / ⚙ Manage — mounts the STANDARD attachment panel (upload, drag &
      // drop, version history, permissions live in that one component) for
      // EXACTLY the requested document, lazily, in the row's manage sub-row
      grid.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
        const [dnId, kind] = b.dataset.up.split(':');
        const r = allRows.find((x) => x.dn_id === +dnId);
        const tr = grid.querySelector(`[data-managerow="${dnId}"]`);
        const cell = tr.firstElementChild;
        if (!cell.querySelector('[data-m]')) cell.innerHTML = '<div data-m="pi"></div><div data-m="dn"></div><div data-m="inv"></div>';
        tr.style.display = '';
        const slot = cell.querySelector(`[data-m="${kind}"]`);
        if (!slot.dataset.ready) {
          slot.dataset.ready = '1';
          if (kind === 'pi') attachmentsPanel(slot, 'purchase_order', orderId, { actor: 'business-file-summary' });
          else if (kind === 'dn') attachmentsPanel(slot, 'delivery_note', r.dn_id, { actor: 'business-file-summary' });
          else if (r.si_id) attachmentsPanel(slot, 'supplier_invoice', r.si_id, { actor: 'business-file-summary' });
        }
        slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }));
    }
    paint();

    host.querySelectorAll('[data-f]').forEach((n) => n.addEventListener(n.tagName === 'SELECT' || n.type === 'date' ? 'change' : 'input', () => {
      state[n.dataset.f] = n.type === 'date' ? n.value : n.value.trim().toLowerCase();
      if (n.tagName === 'SELECT') state[n.dataset.f] = n.value;
      paint();
    }));

    // ---- exports: exactly the visible table --------------------------------
    host.querySelector('[data-sum="xls"]').addEventListener('click', () => {
      if (!window.XLSX) return toast('Excel engine not loaded', 'err');
      const rows = filtered();
      const names = (files) => (files.length ? files.map((f) => f.filename).join(' · ') : 'No Attachment');
      const aoa = [COLS.map((h) => t(h)), ...rows.map((r) => [r.dn, r.dnDate, r.inv, r.invDate, r.grn, r.grDate,
        r.shipped, r.received, r.variance, r.fresh == null ? '' : r.fresh + '%',
        names(r.piFiles), names(r.dnFiles), r.si_id ? names(r.invFiles) : '—', r.status])];
      aoa.push([], ['TOTAL', '', '', '', '', '', rows.reduce((a, r) => a + r.shipped, 0), rows.reduce((a, r) => a + r.received, 0), rows.reduce((a, r) => a + r.variance, 0), '', '', '', '', ''],
        ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')], ['Purchase Order', order.order_number], ['Generated By', 'Roshen Supply Chain — Business File Summary']);
      const ws = window.XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = COLS.map((h, i) => ({ wch: Math.min(46, Math.max(String(h).length + 2, ...aoa.slice(1).map((row) => String(row[i] ?? '').length + 2))) }));
      ws['!autofilter'] = { ref: window.XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: COLS.length - 1 } }) };
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };
      const wb = window.XLSX.utils.book_new();
      window.XLSX.utils.book_append_sheet(wb, ws, 'Business File Summary');
      window.XLSX.writeFile(wb, `${String(order.order_number).replace(/[^\w-]+/g, '_')}_summary.xlsx`);
      toast('Summary exported', 'ok');
    });
    host.querySelector('[data-sum="pdf"]').addEventListener('click', () => {
      const rows = filtered();
      const w = window.open('', '_blank', 'width=1200,height=800');
      if (!w) return toast('Allow pop-ups to export', 'err');
      w.document.write(`<!doctype html><html><head><title>${esc(order.order_number)} — Business File Summary</title><style>
        @page{size:A4 landscape;margin:12mm}
        body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:10px}
        h1{font-size:16px;margin:0}.sub{color:#555;font-size:10px;margin:2px 0 10px}
        .logo{font-size:13px;font-weight:800;letter-spacing:.04em;margin-bottom:2px}
        table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left}
        th{background:#efefef;font-size:9px;text-transform:uppercase} td.r{text-align:right}
        thead{display:table-header-group}tfoot td{font-weight:700;background:#f7f7f7}
        .f{display:inline-block;padding:1px 6px;border-radius:8px;color:#fff;font-weight:700}
        footer{position:fixed;bottom:0;right:0;font-size:8px;color:#888}
      </style></head><body>
        <div class="logo">🏭 Roshen / Relia — Supply Chain</div>
        <h1>Business File Summary — ${esc(order.order_number)}</h1>
        <div class="sub">Supplier: ${esc(order.supplier || '—')} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${rows.length} delivery note(s)</div>
        <table><thead><tr>${COLS.map((h) => `<th>${esc(t(h))}</th>`).join('')}</tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.dn)}</td><td>${esc(r.dnDate)}</td><td>${esc(r.inv || '—')}</td><td>${esc(r.invDate || '—')}</td>
          <td>${esc(r.grn || '—')}</td><td>${esc(r.grDate || '—')}</td>
          <td class="r">${qty(r.shipped)}</td><td class="r">${qty(r.received)}</td><td class="r">${qty(r.variance)}</td>
          <td>${r.fresh == null ? '—' : `<span class="f" style="background:${freshColor(r.fresh)}">${r.fresh}%</span>`}</td>
          <td>📎 ${r.piFiles.length}</td><td>📎 ${r.dnFiles.length}</td><td>${r.si_id ? '📎 ' + r.invFiles.length : '—'}</td>
          <td>${esc(r.status)}</td></tr>`).join('')}
        </tbody><tfoot><tr><td colspan="6">TOTAL — ${rows.length} delivery note(s)</td>
          <td class="r">${qty(rows.reduce((a, r) => a + r.shipped, 0))}</td><td class="r">${qty(rows.reduce((a, r) => a + r.received, 0))}</td>
          <td class="r">${qty(rows.reduce((a, r) => a + r.variance, 0))}</td><td colspan="5"></td></tr></tfoot></table>
        <footer>Roshen / Relia Supply Chain · ${esc(order.order_number)} · page numbers added by the print dialog</footer>
      </body></html>`);
      w.document.close();
      setTimeout(() => { w.print(); }, 400);
    });
  }
}
