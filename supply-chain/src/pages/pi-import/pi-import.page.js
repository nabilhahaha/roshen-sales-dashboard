// PI Import — pick an approved order, upload the Roshen PI Excel, parse it,
// compare against the order, review, and save. Parsing/comparison are pure
// services; this page only orchestrates UI + service calls.
import { mount, wire } from '../../utils/dom.js';
import { esc, money, num } from '../../utils/format.js';
import { piBadge, loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { one } from '../../services/supabase/client.js';
import { listSkus, indexByRoshen } from '../../services/sku/sku.service.js';
import { ordersByStatus, getOrder, comparableLines } from '../../services/purchase-orders/orders.service.js';
import { parseWorkbookFromArrayBuffer } from '../../services/pi/pi-parser.js';
import { comparePiToOrder } from '../../services/pi/pi-compare.js';
import { saveImportedPi } from '../../services/pi/pi.service.js';
import { renderReport } from '../validation/validation-report.view.js';

let SKU_BY_ROSHEN = {};

export async function render(root, ctx) {
  if (!Object.keys(SKU_BY_ROSHEN).length) { try { SKU_BY_ROSHEN = indexByRoshen(await listSkus()); } catch (e) {} }
  const orderId = ctx.params && ctx.params.orderId;
  if (orderId) return openImport(root, ctx, orderId);
  return launcher(root, ctx);
}

async function launcher(root, ctx) {
  mount(root, `<div class="sc-card"><div class="sc-card-h"><h3>📥 PI Import</h3><div class="sc-spacer"></div>
    <span style="font-size:12px;color:var(--text-secondary)">Upload the original Roshen Proforma Invoice for an approved order.</span></div>
    <div data-el="body">${loading()}</div></div>`);
  const body = root.querySelector('[data-el="body"]');
  let orders;
  try { orders = await ordersByStatus(['Approved', 'PI Imported', 'PI Approved']); }
  catch (e) { body.innerHTML = emptyState('⚠', e.message || String(e)); return; }
  if (!orders.length) { body.innerHTML = emptyState('📭', 'No approved orders yet. Approve a purchase order first, then import its Roshen PI here.'); return; }
  const rows = orders.map((o) => {
    const pi = one(o.proforma_invoices);
    const cases = (o.supply_order_items || []).reduce((a, b) => a + Number(b.ordered_cases || 0), 0);
    const val = (o.supply_order_items || []).reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0);
    const action = pi
      ? `<button class="sc-btn sm" data-act="openPI" data-id="${pi.id}">🧾 Open Validation</button>`
      : `<button class="sc-btn sm primary" data-act="import" data-id="${o.id}">📥 Import PI</button>`;
    return `<tr><td class="mono"><b>${esc(o.order_number)}</b></td><td>${esc(o.order_date || '')}</td>
      <td class="num">${num(cases)}</td><td class="num">${money(val)}</td>
      <td>${pi ? piBadge(pi.status) + ` <span class="mono" style="font-size:11px;color:var(--text-muted)">${esc(pi.pi_number || '')}</span>` : '<span class="sc-badge none">No PI</span>'}</td>
      <td>${action}</td></tr>`;
  }).join('');
  body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr><th>Order #</th><th>Date</th><th class="num">Cases</th><th class="num">Net Value</th><th>PI</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`);
  wire(body, {
    import: (d) => ctx.navigate('pi-import', { orderId: +d.id }),
    openPI: (d) => ctx.navigate('validation', { piId: +d.id }),
  });
}

async function openImport(root, ctx, orderId) {
  mount(root, loading('Loading order…'));
  let order;
  try { order = await getOrder(orderId); } catch (e) { toast('Load failed: ' + e.message, 'err'); ctx.navigate('pi-import'); return; }
  const existing = one(order.proforma_invoices);
  if (existing) return ctx.navigate('validation', { piId: existing.id });
  if (order.status !== 'Approved') { toast('PI can only be imported for an Approved order', 'err'); return ctx.navigate('pi-import'); }

  const orderLines = comparableLines(order);
  mount(root, `
    <div class="sc-card-h"><h3>📥 Import Proforma Invoice</h3><div class="sc-spacer"></div>
      <button class="sc-btn sm ghost" data-act="cancel">← Cancel</button></div>
    <div class="sc-card">
      <div style="font-size:12.5px;color:var(--text-secondary);margin-bottom:12px">Linking to approved order
        <b class="mono" style="color:var(--text-primary)">${esc(order.order_number)}</b> · ${orderLines.length} items ·
        ${money(orderLines.reduce((a, b) => a + b.line_total, 0))} SAR (net)</div>
      <div class="erp-drop" data-el="drop">
        <div style="font-size:40px;opacity:.6">📄</div>
        <div style="margin-top:10px;font-weight:700;color:var(--text-primary)">Upload the Roshen Proforma Invoice Excel</div>
        <div style="font-size:12px;color:var(--text-muted);margin-top:4px">.xlsx / .xls — the table is detected automatically (row positions are not hard-coded)</div>
        <input type="file" accept=".xlsx,.xls" data-el="file" style="display:none">
      </div>
    </div>
    <div data-el="result"></div>`);

  const drop = root.querySelector('[data-el="drop"]');
  const fileInput = root.querySelector('[data-el="file"]');
  const result = root.querySelector('[data-el="result"]');
  wire(root, { cancel: () => ctx.navigate('pi-import') });
  drop.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleFile(fileInput.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });

  function handleFile(file) {
    if (!file) return;
    if (typeof window.XLSX === 'undefined') { toast('Excel engine not loaded', 'err'); return; }
    const rd = new FileReader();
    rd.onload = (e) => {
      try {
        const parsed = parseWorkbookFromArrayBuffer(e.target.result, window.XLSX);
        parsed.source_filename = file.name;
        if (!parsed.items.length) throw new Error('No line items were detected in the Excel.');
        const compare = comparePiToOrder(orderLines, parsed);
        toast(`Parsed ${parsed.items.length} PI lines`, 'ok');
        renderReport(result, {
          parsed, compare, order, saved: null, skuByRoshen: SKU_BY_ROSHEN,
          handlers: {
            back: () => ctx.navigate('pi-import'),
            save: async () => {
              try {
                const pi = await saveImportedPi({ orderId, parsed, compare });
                toast('PI saved & linked · status ' + pi.status, 'ok');
                ctx.navigate('validation', { piId: pi.id });
              } catch (err) {
                if (String(err.message || err).includes('duplicate') || err.code === '23505') toast('A PI already exists for this order', 'err');
                else toast('Save failed: ' + (err.message || err), 'err');
              }
            },
          },
        });
        result.scrollIntoView({ behavior: 'smooth' });
      } catch (err) { toast('Import failed: ' + (err.message || err), 'err'); }
    };
    rd.readAsArrayBuffer(file);
  }
}
