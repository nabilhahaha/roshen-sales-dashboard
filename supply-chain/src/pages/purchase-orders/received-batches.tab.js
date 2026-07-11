// "Received Batches" tab on the Purchase Order page — every batch PHYSICALLY
// received for this order, with freshness, quantities and the full document
// chain. Read-only over the existing production data:
//
//   Purchase Order → Delivery Note → Goods Receipt (Released only) →
//   Supplier Invoice (when matched)
//
// Data comes from FOUR bulk queries (receipts, their released batches, the
// order's matched invoices, the SKU master rows) — no per-row calls. Freshness
// uses the system's ONE shelf-life rule (models/shelf-life.js shelfLife():
// remaining / total × 100); the display bands are 90+ green, 80+ yellow,
// 70+ orange, below 70 red. Attachments in the drawer are the standard
// per-document panels (lazy, mounted when the drawer opens).
import { esc, qty, today } from '../../utils/format.js';
import { getClient } from '../../services/supabase/client.js';
import { shelfLife, humanDuration } from '../../models/shelf-life.js';
import { statusBadge } from '../../components/table/badges.js';
import { openDrawer } from '../../components/document/document-shell.js';
import { attachmentsPanel } from '../../components/attachments/attachments-panel.js';
import { toast } from '../../components/notifications/toast.js';

const BANDS = [
  { min: 90, key: 'green', label: 'Green (90–100%)', color: '#2FB344' },
  { min: 80, key: 'yellow', label: 'Yellow (80–89%)', color: '#F2C037' },
  { min: 70, key: 'orange', label: 'Orange (70–79%)', color: '#F76707' },
  { min: -1, key: 'red', label: 'Red (below 70%)', color: '#E03131' },
];
const bandOf = (pct) => (pct == null ? null : BANDS.find((b) => pct >= b.min));
const remainText = (days) => {
  if (days == null || isNaN(days)) return '—';
  if (days < 0) return 'Expired ' + Math.abs(Math.round(days)) + ' days ago';
  const m = Math.floor(days / 30), d = Math.round(days % 30);
  return `${m ? m + ' Months ' : ''}${d} Days Remaining`;
};
const freshChip = (sl) => {
  if (!sl || sl.remainingPct == null) return '<span class="sc-badge none">n/a</span>';
  const b = bandOf(sl.remainingPct);
  return `<span class="rb-fresh" style="--c:${b.color}"><b>${sl.remainingPct}%</b><span>${esc(remainText(sl.remainingDays))}</span></span>`;
};

const COLS = [
  { key: 'item_code', label: 'SKU' },
  { key: 'roshen_id', label: 'Roshen Code' },
  { key: 'description', label: 'Item Description' },
  { key: 'batch_no', label: 'Batch' },
  { key: 'received', label: 'Received Qty', num: true },
  { key: 'manufacturing_date', label: 'Production' },
  { key: 'expiry_date', label: 'Expiry' },
  { key: 'total_days', label: 'Shelf Life', num: true },
  { key: 'remaining_days', label: 'Remaining', num: true },
  { key: 'pct', label: 'Freshness %', num: true },
  { key: 'grn', label: 'Goods Receipt' },
  { key: 'dn', label: 'Delivery Note' },
  { key: 'invoice', label: 'Supplier Invoice' },
  { key: 'received_at', label: 'Received Date' },
  { key: 'warehouse', label: 'Warehouse' },
  { key: 'status', label: 'Status' },
];

// module state per render (the tab re-renders fresh per document open)
export async function renderReceivedBatchesTab(el, { orderId, orderNumber, supplier, navigate }) {
  const c = getClient();
  // ---- bulk data (no N+1) ---------------------------------------------------
  const { data: grs } = await c.from('goods_receipts')
    .select('id,grn_number,warehouse,released_at,status,delivery_note_id, delivery_notes(dn_number)')
    .eq('order_id', orderId).in('status', ['Released', 'Partially Released']);
  const grIds = (grs || []).map((g) => g.id);
  const [{ data: batches }, { data: sis }] = await Promise.all([
    grIds.length ? c.from('goods_receipt_batches')
      .select('id,gr_id,sku_id,item_code,roshen_id,description,batch_no,manufacturing_date,expiry_date,received_cases,qc_result')
      .in('gr_id', grIds).eq('qc_result', 'Released').gt('received_cases', 0).range(0, 4999) : { data: [] },
    c.from('supplier_invoices').select('id,invoice_number,delivery_note_id,status,doc_type')
      .eq('order_id', orderId).eq('doc_type', 'invoice').eq('status', 'Matched'),
  ]);
  const skuIds = [...new Set((batches || []).map((b) => b.sku_id).filter(Boolean))];
  const { data: skus } = skuIds.length ? await c.from('sku_master')
    .select('id,item_description,shelf_life_value,shelf_life_unit,min_remaining_shelf_life_pct').in('id', skuIds) : { data: [] };
  const skuById = {}; (skus || []).forEach((s) => { skuById[s.id] = s; });
  const grById = {}; (grs || []).forEach((g) => { grById[g.id] = g; });
  const siByDn = {}; (sis || []).forEach((s) => { if (!siByDn[s.delivery_note_id]) siByDn[s.delivery_note_id] = s; });

  const asOf = today();
  const rows = (batches || []).map((b) => {
    const gr = grById[b.gr_id] || {};
    const sku = skuById[b.sku_id] || null;
    const si = siByDn[gr.delivery_note_id] || null;
    const sl = shelfLife(sku, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, asOf);
    return {
      id: b.id, gr_id: b.gr_id, dn_id: gr.delivery_note_id, si_id: si ? si.id : null,
      item_code: b.item_code || '', roshen_id: String(b.roshen_id || ''),
      description: b.description || (sku && sku.item_description) || '',
      batch_no: b.batch_no || '—',
      received: Number(b.received_cases || 0),
      manufacturing_date: b.manufacturing_date || '', expiry_date: b.expiry_date || '',
      total_days: sl.totalDays, remaining_days: sl.remainingDays, pct: sl.remainingPct, sl,
      grn: gr.grn_number || '', dn: (gr.delivery_notes && gr.delivery_notes.dn_number) || '',
      invoice: si ? si.invoice_number : '',
      received_at: String(gr.released_at || '').slice(0, 10), warehouse: gr.warehouse || '',
      status: sl.expired ? 'Expired' : 'Released',
    };
  });

  // ---- KPIs ------------------------------------------------------------------
  const withPct = rows.filter((r) => r.pct != null);
  const k = {
    cases: rows.reduce((a, r) => a + r.received, 0),
    batches: rows.length,
    avg: withPct.length ? +(withPct.reduce((a, r) => a + r.pct, 0) / withPct.length).toFixed(1) : null,
    low: withPct.length ? Math.min(...withPct.map((r) => r.pct)) : null,
    below70: withPct.filter((r) => r.pct < 70).length,
    expired: rows.filter((r) => r.sl.expired).length,
    earliestExpiry: rows.map((r) => r.expiry_date).filter(Boolean).sort()[0] || '—',
    latestProd: rows.map((r) => r.manufacturing_date).filter(Boolean).sort().slice(-1)[0] || '—',
  };

  const state = { q: '', warehouse: '', band: '', status: '', dn: '', grn: '', si: '', expBefore: '', group: false, sort: { key: 'expiry_date', dir: 1 } };
  const uniq = (key) => [...new Set(rows.map((r) => r[key]).filter(Boolean))].sort();

  const kpi = (l, v, cls = '') => `<div class="erp-kpi rb-kpi ${cls}"><div class="k-lbl">${l}</div><div class="k-val">${v}</div></div>`;
  const sel = (id, label, values) => `<select class="sc-select sm" data-f="${id}"><option value="">${label}</option>${values.map((v) => `<option>${esc(v)}</option>`).join('')}</select>`;

  el.innerHTML = `
    <div class="erp-kpi-row" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      ${kpi('Total Received Cases', qty(k.cases))}${kpi('Total Batches', k.batches)}
      ${kpi('Average Freshness', k.avg == null ? '—' : k.avg + '%')}${kpi('Lowest Freshness', k.low == null ? '—' : k.low + '%')}
      ${kpi('Below 70%', k.below70, k.below70 ? 'rb-bad' : '')}${kpi('Expired Batches', k.expired, k.expired ? 'rb-bad' : '')}
      ${kpi('Earliest Expiry', esc(k.earliestExpiry))}${kpi('Latest Production', esc(k.latestProd))}
    </div>
    <div class="sc-card">
      <div class="rb-bar">
        <input class="sc-input sm" data-f="q" placeholder="🔎 SKU · Roshen · item · batch · DN · GRN · invoice…" style="min-width:250px;flex:1">
        ${sel('warehouse', 'Warehouse', uniq('warehouse'))}
        ${sel('dn', 'Delivery Note', uniq('dn'))}
        ${sel('grn', 'Goods Receipt', uniq('grn'))}
        ${sel('si', 'Invoice', uniq('invoice'))}
        <select class="sc-select sm" data-f="band"><option value="">Freshness</option>${BANDS.map((b) => `<option value="${b.key}">${b.label}</option>`).join('')}</select>
        <select class="sc-select sm" data-f="status"><option value="">Status</option><option>Released</option><option>Expired</option></select>
        <label class="rb-datef">Expiry ≤ <input type="date" class="sc-input sm" data-f="expBefore"></label>
        <span class="sc-spacer"></span>
        <label class="rb-group"><input type="checkbox" data-f="group"> Group by SKU</label>
        <button class="sc-btn sm ghost" data-rb="xls">📊 Export Excel</button>
        <button class="sc-btn sm ghost" data-rb="pdf">🖨 Export PDF</button>
      </div>
      <div data-el="grid"></div>
    </div>`;

  const grid = el.querySelector('[data-el="grid"]');

  const filtered = () => {
    const q = state.q.toLowerCase();
    let out = rows.filter((r) =>
      (!q || [r.item_code, r.roshen_id, r.description, r.batch_no, r.dn, r.grn, r.invoice].some((v) => String(v).toLowerCase().includes(q)))
      && (!state.warehouse || r.warehouse === state.warehouse)
      && (!state.dn || r.dn === state.dn)
      && (!state.grn || r.grn === state.grn)
      && (!state.si || r.invoice === state.si)
      && (!state.band || (bandOf(r.pct) && bandOf(r.pct).key === state.band))
      && (!state.status || r.status === state.status)
      && (!state.expBefore || (r.expiry_date && r.expiry_date <= state.expBefore)));
    const { key, dir } = state.sort;
    out.sort((a, b) => {
      const x = a[key], y = b[key];
      if (x == null && y == null) return 0;
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
    return out;
  };

  const rowHtml = (r) => `<tr class="sc-row-link" data-batch="${r.id}">
    <td class="mono"><b>${esc(r.item_code)}</b></td><td class="mono">${esc(r.roshen_id)}</td>
    <td style="font-size:12px;max-width:210px">${esc(r.description.slice(0, 44))}</td>
    <td class="mono">${esc(r.batch_no)}</td>
    <td class="num"><b>${qty(r.received)}</b></td>
    <td>${esc(r.manufacturing_date || '—')}</td><td>${esc(r.expiry_date || '—')}</td>
    <td class="num">${r.total_days ? humanDuration(r.total_days) : '—'}</td>
    <td class="num">${r.remaining_days != null ? humanDuration(r.remaining_days) : '—'}</td>
    <td>${freshChip(r.sl)}</td>
    <td class="mono" style="font-size:11px">${esc(r.grn)}</td>
    <td class="mono" style="font-size:11px">${esc(r.dn)}</td>
    <td class="mono" style="font-size:11px">${esc(r.invoice || '—')}</td>
    <td>${esc(r.received_at)}</td><td>${esc(r.warehouse)}</td>
    <td>${r.status === 'Expired' ? '<span class="sc-badge closed">Expired</span>' : statusBadge('Released')}</td></tr>`;

  function paint() {
    const data = filtered();
    const head = COLS.map((cdef) => `<th class="${cdef.num ? 'num' : ''} rb-sort" data-sort="${cdef.key}">${cdef.label}${state.sort.key === cdef.key ? (state.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
    let bodyHtml = '';
    if (!state.group) bodyHtml = data.map(rowHtml).join('');
    else {
      const bySku = {};
      data.forEach((r) => { (bySku[r.item_code + '|' + r.roshen_id] = bySku[r.item_code + '|' + r.roshen_id] || []).push(r); });
      bodyHtml = Object.values(bySku).map((list) => {
        const r0 = list[0];
        const tot = list.reduce((a, r) => a + r.received, 0);
        return `<tr class="rb-skuhead"><td colspan="4">📦 <b>${esc(r0.item_code)}</b> · ${esc(r0.roshen_id)} — ${esc(r0.description.slice(0, 50))}</td>
          <td class="num"><b>${qty(tot)}</b></td><td colspan="${COLS.length - 5}" style="font-size:11px;color:var(--text-muted)">${list.length} batch(es) · total received ${qty(tot)}</td></tr>
          ${list.map(rowHtml).join('')}`;
      }).join('');
    }
    grid.innerHTML = `<div class="sc-table-wrap"><table class="sc-table rb-table"><thead><tr>${head}</tr></thead><tbody>
      ${bodyHtml || `<tr><td colspan="${COLS.length}" style="text-align:center;color:var(--text-muted);padding:20px">No received batches match the current filters.</td></tr>`}</tbody></table></div>
      <p style="font-size:11.5px;color:var(--text-muted);margin:8px 0 0">${data.length} batch(es) · ${qty(data.reduce((a, r) => a + r.received, 0))} cases shown · click a row for the batch file & document chain</p>`;

    grid.querySelectorAll('[data-sort]').forEach((h) => h.addEventListener('click', () => {
      const key2 = h.dataset.sort;
      state.sort = { key: key2, dir: state.sort.key === key2 ? -state.sort.dir : 1 };
      paint();
    }));
    grid.querySelectorAll('[data-batch]').forEach((tr) => tr.addEventListener('click', () => openBatchDrawer(rows.find((r) => r.id === Number(tr.dataset.batch)))));
  }

  el.querySelectorAll('[data-f]').forEach((n) => n.addEventListener(n.type === 'checkbox' || n.tagName === 'SELECT' || n.type === 'date' ? 'change' : 'input', () => {
    if (n.dataset.f === 'group') state.group = n.checked;
    else state[n.dataset.f] = n.value;
    paint();
  }));

  // ---- row drawer: batch file + clickable chain + per-owner attachments -----
  function openBatchDrawer(r) {
    if (!r) return;
    const kvs = (l, v) => `<div class="bf-kv"><span>${l}</span><b>${v}</b></div>`;
    const chainBtn = (icon, label, num2, nav, p, ok = true) => (ok
      ? `<button class="rb-chain" data-nav="${nav}" data-p='${esc(JSON.stringify(p))}'>${icon} <b>${esc(num2)}</b><span>${label}</span></button>`
      : `<div class="rb-chain rb-chain-off">${icon} <b>—</b><span>${label} (pending)</span></div>`);
    const body = openDrawer('🔖 Batch ' + (r.batch_no === '—' ? r.item_code : r.batch_no), `
      <div class="bf-info" style="margin-top:0">
        ${kvs('SKU', esc(r.item_code))}${kvs('Roshen', esc(r.roshen_id))}${kvs('Description', esc(r.description.slice(0, 60)))}
        ${kvs('Received Qty', qty(r.received))}${kvs('Production', esc(r.manufacturing_date || '—'))}${kvs('Expiry', esc(r.expiry_date || '—'))}
        ${kvs('Freshness', freshChip(r.sl))}${kvs('Shelf Life', r.total_days ? humanDuration(r.total_days) : '—')}
        ${kvs('Remaining', esc(remainText(r.remaining_days)))}${kvs('Warehouse', esc(r.warehouse))}${kvs('Received', esc(r.received_at))}${kvs('Status', esc(r.status))}
      </div>
      <div class="sc-card"><div class="sc-card-h"><h3>🔗 Document Chain</h3></div>
        <div class="rb-chainrow">
          ${chainBtn('📋', 'Purchase Order', orderNumber, 'purchase-orders', { orderId, mode: 'view' })}
          <span class="rb-arr">→</span>
          ${chainBtn('🚚', 'Delivery Note', r.dn, 'delivery-notes', { view: 'detail', dnId: r.dn_id }, !!r.dn_id)}
          <span class="rb-arr">→</span>
          ${chainBtn('📦', 'Goods Receipt', r.grn, 'goods-receiving', { view: 'detail', grId: r.gr_id }, !!r.gr_id)}
          <span class="rb-arr">→</span>
          ${chainBtn('🧾', 'Supplier Invoice', r.invoice || '—', 'supplier-invoices', { view: 'detail', invoiceId: r.si_id }, !!r.si_id)}
        </div></div>
      <div data-o="po"></div><div data-o="dn"></div><div data-o="gr"></div><div data-o="si"></div>`);
    body.querySelectorAll('.rb-chain[data-nav]').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('.doc-drawer-overlay').forEach((n) => n.remove());
      navigate(b.dataset.nav, JSON.parse(b.dataset.p));
    }));
    // per-owner attachments — the standard panel, one per document, lazy here
    attachmentsPanel(body.querySelector('[data-o="po"]'), 'purchase_order', orderId, { actor: 'received-batches' });
    if (r.dn_id) attachmentsPanel(body.querySelector('[data-o="dn"]'), 'delivery_note', r.dn_id, { actor: 'received-batches' });
    if (r.gr_id) attachmentsPanel(body.querySelector('[data-o="gr"]'), 'goods_receipt', r.gr_id, { actor: 'received-batches' });
    if (r.si_id) attachmentsPanel(body.querySelector('[data-o="si"]'), 'supplier_invoice', r.si_id, { actor: 'received-batches' });
  }

  // ---- exports ----------------------------------------------------------------
  el.querySelector('[data-rb="xls"]').addEventListener('click', async () => {
    if (!window.XLSX) return toast('Excel engine not loaded', 'err');
    const data = filtered();
    const header = COLS.map((cdef) => cdef.label).concat('Freshness Band');
    const aoa = [header, ...data.map((r) => [
      r.item_code, r.roshen_id, r.description, r.batch_no, r.received,
      r.manufacturing_date, r.expiry_date, r.total_days ? humanDuration(r.total_days) : '',
      remainText(r.remaining_days), r.pct == null ? '' : r.pct + '%',
      r.grn, r.dn, r.invoice, r.received_at, r.warehouse, r.status,
      r.pct == null ? '' : bandOf(r.pct).key.toUpperCase(),
    ])];
    const wp = data.filter((r) => r.pct != null);
    aoa.push([], ['Total Cases', data.reduce((a, r) => a + r.received, 0)],
      ['Total Batches', data.length],
      ['Average Freshness', wp.length ? +(wp.reduce((a, r) => a + r.pct, 0) / wp.length).toFixed(1) + '%' : '—'],
      ['Lowest Freshness', wp.length ? Math.min(...wp.map((r) => r.pct)) + '%' : '—'],
      ['Generated', new Date().toISOString().slice(0, 16).replace('T', ' ')],
      ['Purchase Order', orderNumber], ['Generated By', 'Roshen Supply Chain — Received Batches']);
    const ws = window.XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = header.map((h, i) => ({ wch: Math.min(42, Math.max(String(h).length + 2, ...aoa.slice(1).map((row) => String(row[i] ?? '').length + 2))) }));
    ws['!autofilter'] = { ref: window.XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length, c: header.length - 1 } }) };
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };
    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, 'Received Batches');
    window.XLSX.writeFile(wb, `${orderNumber.replace(/[^\w-]+/g, '_')}_received_batches.xlsx`);
    toast('Received Batches exported', 'ok');
  });

  el.querySelector('[data-rb="pdf"]').addEventListener('click', () => {
    const data = filtered();
    const w = window.open('', '_blank', 'width=1200,height=800');
    if (!w) return toast('Allow pop-ups to export the PDF', 'err');
    const wp = data.filter((r) => r.pct != null);
    w.document.write(`<!doctype html><html><head><title>${esc(orderNumber)} — Received Batches</title><style>
      @page{size:A4 landscape;margin:12mm}
      body{font-family:Arial,Helvetica,sans-serif;color:#111;font-size:10px;counter-reset:page}
      h1{font-size:16px;margin:0}.sub{color:#555;font-size:10px;margin:2px 0 10px}
      .logo{font-size:13px;font-weight:800;letter-spacing:.04em}
      .kpis{display:flex;gap:14px;margin:8px 0 12px;flex-wrap:wrap}
      .kpis div{border:1px solid #ccc;border-radius:6px;padding:5px 10px}
      .kpis span{display:block;font-size:8px;text-transform:uppercase;color:#777}
      table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 5px;text-align:left}
      th{background:#efefef;font-size:9px} td.r{text-align:right}
      .f{display:inline-block;padding:1px 6px;border-radius:8px;color:#fff;font-weight:700}
      tfoot td{font-weight:700;background:#f7f7f7}
      footer{position:fixed;bottom:0;right:0;font-size:8px;color:#888}
    </style></head><body>
      <div class="logo">🏭 Roshen / Relia — Supply Chain</div>
      <h1>Received Batches — ${esc(orderNumber)}</h1>
      <div class="sub">Supplier: ${esc(supplier || '—')} · Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${data.length} batches</div>
      <div class="kpis">
        <div><span>Total Cases</span><b>${qty(data.reduce((a, r) => a + r.received, 0))}</b></div>
        <div><span>Batches</span><b>${data.length}</b></div>
        <div><span>Avg Freshness</span><b>${wp.length ? (wp.reduce((a, r) => a + r.pct, 0) / wp.length).toFixed(1) + '%' : '—'}</b></div>
        <div><span>Lowest</span><b>${wp.length ? Math.min(...wp.map((r) => r.pct)) + '%' : '—'}</b></div>
        <div><span>Below 70%</span><b>${wp.filter((r) => r.pct < 70).length}</b></div>
        <div><span>Expired</span><b>${data.filter((r) => r.status === 'Expired').length}</b></div>
      </div>
      <table><thead><tr>${COLS.map((cdef) => `<th>${cdef.label}</th>`).join('')}</tr></thead><tbody>
      ${data.map((r) => `<tr>
        <td>${esc(r.item_code)}</td><td>${esc(r.roshen_id)}</td><td>${esc(r.description.slice(0, 38))}</td><td>${esc(r.batch_no)}</td>
        <td class="r">${qty(r.received)}</td><td>${esc(r.manufacturing_date || '—')}</td><td>${esc(r.expiry_date || '—')}</td>
        <td class="r">${r.total_days ? humanDuration(r.total_days) : '—'}</td><td class="r">${r.remaining_days != null ? humanDuration(r.remaining_days) : '—'}</td>
        <td>${r.pct == null ? '—' : `<span class="f" style="background:${bandOf(r.pct).color}">${r.pct}%</span>`}</td>
        <td>${esc(r.grn)}</td><td>${esc(r.dn)}</td><td>${esc(r.invoice || '—')}</td>
        <td>${esc(r.received_at)}</td><td>${esc(r.warehouse)}</td><td>${esc(r.status)}</td></tr>`).join('')}
      </tbody><tfoot><tr><td colspan="4">TOTAL</td><td class="r">${qty(data.reduce((a, r) => a + r.received, 0))}</td><td colspan="${COLS.length - 5}">${data.length} batches</td></tr></tfoot></table>
      <footer>Roshen / Relia Supply Chain · ${esc(orderNumber)} · page numbers added by the print dialog</footer>
    </body></html>`);
    w.document.close();
    setTimeout(() => { w.print(); }, 400);
  });

  paint();
}
