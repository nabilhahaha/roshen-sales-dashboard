// PI Validation — list proforma invoices, or open one saved PI's validation
// report with approve / reject / return-to-revision actions.
import { mount, wire } from '../../utils/dom.js';
import { esc, money } from '../../utils/format.js';
import { piBadge, loading, emptyState, tableWrap } from '../../components/table/table.js';
import { toast } from '../../components/notifications/toast.js';
import { modal } from '../../components/modal/modal.js';
import { orderBadge } from '../../components/table/table.js';
import { esc as escFmt, qty as fmtQty } from '../../utils/format.js';
import { listSkus, indexByRoshen } from '../../services/sku/sku.service.js';
import { getOrder } from '../../services/purchase-orders/orders.service.js';
import { listPis, getPiWithItems, approvePi, readyForShipment } from '../../services/pi/pi.service.js';
import { getEffectiveLines, listRevisions } from '../../services/purchase-orders/revision.service.js';
import { comparePiToOrder } from '../../services/pi/pi-compare.js';
import { renderReport } from './validation-report.view.js';
import { printPi, exportPiExcel } from '../../utils/documents.js';

let SKU_BY_ROSHEN = {};

export async function render(root, ctx) {
  if (!Object.keys(SKU_BY_ROSHEN).length) { try { SKU_BY_ROSHEN = indexByRoshen(await listSkus()); } catch (e) {} }
  const piId = ctx.params && ctx.params.piId;
  if (piId) return openSaved(root, ctx, piId);
  return list(root, ctx);
}

async function list(root, ctx) {
  mount(root, `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Proforma Invoices</h3><div class="sc-spacer"></div>
    <button class="sc-btn ghost sm" data-act="refresh">↻</button></div><div data-el="body">${loading()}</div></div>`);
  const body = root.querySelector('[data-el="body"]');
  let pis;
  try { pis = await listPis(); } catch (e) { body.innerHTML = emptyState('⚠', e.message || String(e)); return; }
  if (!pis.length) { body.innerHTML = emptyState('📭', 'No proforma invoices yet. Approve an order and import its PI.'); return; }
  const rows = pis.map((pi) => `<tr>
    <td class="mono"><b>${esc(pi.pi_number || '—')}</b></td><td>${esc(pi.pi_date || '—')}</td>
    <td class="mono">${esc(pi.supply_orders ? pi.supply_orders.order_number : '—')}</td>
    <td>${esc(pi.supplier || '—')}</td><td>${esc(pi.currency || '')}</td>
    <td class="num">${money(pi.total_taxable)}</td><td class="num">${money(pi.grand_total)}</td>
    <td>${piBadge(pi.status)}</td>
    <td><div class="sc-actions-cell">
      <button class="sc-icon-btn" title="Validation Report" data-act="open" data-id="${pi.id}">👁</button>
      <button class="sc-icon-btn" title="Print" data-act="print" data-id="${pi.id}">🖨</button>
      <button class="sc-icon-btn" title="Excel" data-act="xls" data-id="${pi.id}">⬇</button>
    </div></td></tr>`).join('');
  body.innerHTML = tableWrap(`<table class="sc-table"><thead><tr><th>PI #</th><th>PI Date</th><th>Order</th><th>Supplier</th><th>Cur</th><th class="num">Net (taxable)</th><th class="num">Grand (incl VAT)</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`);
  wire(root, {
    refresh: () => list(root, ctx),
    open: (d) => ctx.navigate('validation', { piId: +d.id }),
    print: async (d) => { try { const pi = await getPiWithItems(+d.id); const o = await getOrder(pi.order_id); if (!printPi(pi, o.order_number)) toast('Allow pop-ups to print', 'err'); } catch (e) { toast(e.message, 'err'); } },
    xls: async (d) => { try { const pi = await getPiWithItems(+d.id); const o = await getOrder(pi.order_id); exportPiExcel(pi, o.order_number); toast('Exported', 'ok'); } catch (e) { toast(e.message, 'err'); } },
  });
}

export function toParsed(pi) {
  return {
    header: { pi_number: pi.pi_number, pi_date: pi.pi_date, supplier: pi.supplier, customer: pi.customer, currency: pi.currency, payment_terms: pi.payment_terms, delivery_terms: pi.delivery_terms, vat_number: pi.vat_number, cr_number: pi.cr_number },
    items: (pi.proforma_invoice_items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0)).map((x) => ({
      line_no: x.line_no, pi_item_code: x.pi_item_code, roshen_id: x.roshen_id ? String(x.roshen_id).trim() : null, description: x.description,
      uom: x.uom, quantity: Number(x.quantity), box_pcs: Number(x.box_pcs), unit_price: Number(x.unit_price), case_price: Number(x.case_price),
      discount_percent: x.discount_percent, net_price: x.net_price, taxable_amount: Number(x.taxable_amount), vat_percent: x.vat_percent, vat_amount: x.vat_amount, line_total: Number(x.line_total),
    })),
    totals: { total_quantity: pi.total_quantity, total_taxable: pi.total_taxable, total_vat: pi.total_vat, grand_total: pi.grand_total, gross_weight: pi.gross_weight },
    source_filename: pi.source_filename,
  };
}

async function openSaved(root, ctx, piId) {
  mount(root, loading('Loading validation report…'));
  let pi, order;
  try { pi = await getPiWithItems(piId); order = await getOrder(pi.order_id); }
  catch (e) { toast('Load failed: ' + e.message, 'err'); return list(root, ctx); }
  const parsed = toParsed(pi);
  // Compare the PI against the CURRENT effective PO (latest revision, else original).
  const compare = comparePiToOrder(await getEffectiveLines(order), parsed);

  mount(root, '<div data-el="report"></div><div data-el="history"></div>');
  renderReport(root.querySelector('[data-el="report"]'), {
    parsed, compare, order, saved: pi, skuByRoshen: SKU_BY_ROSHEN,
    handlers: {
      back: () => ctx.navigate('validation'),
      print: () => { if (!printPi(pi, order.order_number)) toast('Allow pop-ups to print', 'err'); },
      excel: () => { exportPiExcel(pi, order.order_number); toast('Exported', 'ok'); },
      // differences → open the revision screen (never reject the PI)
      revise: () => ctx.navigate('po-revision', { orderId: order.id, piId }),
      approve: () => modal('Approve Proforma Invoice?',
        'The purchase order (latest revision) matches the PI. Mark the PI <b>Approved</b> and advance the order to <b>PI Approved</b>.',
        [{ label: 'Approve PI', cls: 'green', onClick: async () => { try { await approvePi(piId, order.id); } catch (e) { toast(e.message, 'err'); return; } toast('PI approved · order advanced to PI Approved', 'ok'); openSaved(root, ctx, piId); } }, { label: 'Cancel', cls: 'ghost' }]),
      ship: () => modal('Mark ready for shipment?',
        'Finalise this order as <b>Ready for Shipment</b>. Downstream modules (Shipment, Goods Receiving, Inventory, Finance) reference the latest approved revision.',
        [{ label: 'Ready for Shipment', cls: 'green', onClick: async () => { try { await readyForShipment(order.id); } catch (e) { toast(e.message, 'err'); return; } toast('Order ready for shipment', 'ok'); openSaved(root, ctx, piId); } }, { label: 'Cancel', cls: 'ghost' }]),
    },
  });
  renderHistory(root.querySelector('[data-el="history"]'), order);
}

const CHANGE_LABEL = {
  removed_item: (c) => `🗑 Removed <b>${escFmt(c.item_code)}</b>`,
  quantity_change: (c) => `🔢 Qty <b>${escFmt(c.item_code)}</b>: ${fmtQty(c.old_qty)} → ${fmtQty(c.new_qty)}`,
  price_change: (c) => `💲 Price <b>${escFmt(c.item_code)}</b>: ${fmtQty(c.old_price)} → ${fmtQty(c.new_price)}`,
  added_item: (c) => `➕ Added <b>${escFmt(c.item_code)}</b>: qty ${fmtQty(c.new_qty)} @ ${fmtQty(c.new_price)}`,
  kept_item: (c) => `↔ Kept <b>${escFmt(c.item_code)}</b>`,
};

async function renderHistory(el, order) {
  if (!el) return;
  let revs = [];
  try { revs = await listRevisions(order.id); } catch (e) {}
  revs.sort((a, b) => a.revision_no - b.revision_no);
  const origCount = (order.supply_order_items || []).length;

  const rev0 = `<div class="erp-rev"><div class="erp-rev-h"><b>Revision 0 — Original</b>
    <span class="sc-badge none">${origCount} items</span></div>
    <div style="font-size:12px;color:var(--text-muted)">The original purchase order, preserved for audit.</div></div>`;

  const revCards = revs.map((r) => {
    const changes = (r.supply_order_revision_changes || []).map((c) => {
      const label = (CHANGE_LABEL[c.change_type] || (() => c.change_type))(c);
      return `<div class="erp-rev-change">${label}${c.reason ? ` <span style="color:var(--text-muted)">— ${escFmt(c.reason)}</span>` : ''}
        <span style="float:right;font-size:11px;color:var(--text-muted)">${escFmt(c.accepted_by || '—')} · ${escFmt(String(c.accepted_at || '').slice(0, 16).replace('T', ' '))}</span></div>`;
    }).join('') || '<div style="font-size:12px;color:var(--text-muted)">No recorded changes.</div>';
    return `<div class="erp-rev"><div class="erp-rev-h"><b>Revision ${r.revision_no}</b>
      <span class="sc-badge pi">${(r.supply_order_revision_items || []).length} items</span>
      ${order.current_revision === r.revision_no ? '<span class="sc-badge confirmed">current</span>' : ''}
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${escFmt(String(r.created_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      <div class="erp-rev-changes">${changes}</div></div>`;
  }).join('');

  el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Revision History &amp; Audit</h3>
    <div class="sc-spacer"></div>${orderBadge(order.status)}
    <span class="sc-badge none" style="margin-left:6px">Current: Revision ${order.current_revision || 0}</span></div>
    <div class="erp-rev-timeline">${rev0}${revCards}</div></div>`;
}
