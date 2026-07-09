// Delivery Note detail — header, lines & batches (with live shelf life), the
// supplier-invoice match gate, and goods-receipt creation.
import { mount, wire } from '../../utils/dom.js';
import { esc, qty, today } from '../../utils/format.js';
import { loading, emptyState } from '../../components/table/table.js';
import { modal } from '../../components/modal/modal.js';
import { toast } from '../../components/notifications/toast.js';
import { statusBadge, qcBadge, shelfChip } from '../../components/table/badges.js';
import { shelfLife } from '../../models/shelf-life.js';
import { getDeliveryNote } from '../../services/delivery-note/delivery-note.service.js';
import { listSkus, indexByRoshen, indexByCode } from '../../services/sku/sku.service.js';
import { priceIndex } from '../../services/fulfillment/fulfillment.service.js';
import {
  invoiceLinesFromDeliveryNote, createSupplierInvoice, matchInvoiceToDeliveryNote,
} from '../../services/supplier-invoice/supplier-invoice.service.js';
import { createGoodsReceiptFromDeliveryNote } from '../../services/goods-receiving/goods-receiving.service.js';

export async function renderDnDetail(root, ctx, dnId) {
  mount(root, loading('Loading delivery note…'));
  let dn, skus, byRoshen, byCode;
  try {
    [dn, skus] = await Promise.all([getDeliveryNote(dnId), listSkus()]);
    byRoshen = indexByRoshen(skus); byCode = indexByCode(skus);
  } catch (e) { return mount(root, emptyState('⚠', e.message || String(e))); }

  const skuFor = (l) => byRoshen[String(l.roshen_id || '').trim()] || byCode[String(l.item_code || '').trim()] || null;

  const lineRows = dn.items.map((it) => {
    const sku = skuFor(it);
    const total = (it.batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
    const head = `<tr class="sc-row-head">
      <td class="mono"><b>${esc(it.roshen_id || it.item_code)}</b><div style="font-size:11px;color:var(--text-muted)">${esc(it.item_code || '')}</div></td>
      <td colspan="2">${esc(it.description || '')}</td>
      <td class="num"><b>${qty(total)}</b></td><td colspan="2">${it.match_status === 'additional' ? '<span class="sc-badge closed">Extra</span>' : '<span class="sc-badge confirmed">On PO</span>'}</td></tr>`;
    const batches = (it.batches || []).map((b) => {
      const sl = shelfLife(sku, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, today());
      return `<tr>
        <td class="mono" style="padding-left:22px">${esc(b.batch_no || '—')}</td>
        <td>${esc(b.expiry_date || '—')}</td><td>${esc(b.manufacturing_date || '')}</td>
        <td class="num">${qty(b.cases)}</td><td>${shelfChip(sl)}</td><td>${qcBadge(b.qc_status)}</td></tr>`;
    }).join('');
    return head + batches;
  }).join('');

  const inv = dn.invoice;
  const gr = dn.goods_receipt;
  const invMatched = inv && inv.status === 'Matched';

  let invoiceCard;
  if (!inv) {
    invoiceCard = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Supplier Invoice</h3></div>
      <p style="font-size:12.5px;color:var(--text-secondary)">Each delivery note needs exactly one matching supplier invoice before goods can be received. Create the invoice from this DN (priced at the PO case price) and match it.</p>
      <button class="sc-btn primary" data-act="invoice">➕ Create &amp; Match Supplier Invoice</button></div>`;
  } else {
    invoiceCard = `<div class="sc-card"><div class="sc-card-h"><h3>🧾 Supplier Invoice</h3><div class="sc-spacer"></div>${statusBadge(inv.status)}</div>
      <div style="display:flex;gap:22px;flex-wrap:wrap;font-size:12.5px">
        <div>Invoice #: <b>${esc(inv.invoice_number)}</b></div><div>Date: <b>${esc(inv.invoice_date || '—')}</b></div>
        <div>Net: <b>${qty(inv.total_taxable)}</b></div><div>Grand: <b>${qty(inv.grand_total)}</b></div></div>
      ${!invMatched ? '<button class="sc-btn ghost" style="margin-top:12px" data-act="rematch">🔗 Re-check match</button>' : ''}</div>`;
  }

  let grCard;
  if (gr) {
    grCard = `<div class="sc-card"><div class="sc-card-h"><h3>📦 Goods Receipt</h3><div class="sc-spacer"></div>${statusBadge(gr.status)}</div>
      <button class="sc-btn primary" data-act="opengr" data-id="${gr.id}">Open Goods Receipt →</button></div>`;
  } else {
    grCard = `<div class="sc-card"><div class="sc-card-h"><h3>📦 Goods Receipt</h3></div>
      <p style="font-size:12.5px;color:var(--text-secondary)">${invMatched
        ? 'Invoice matched — you can now receive the goods (batch-level QC).'
        : 'Blocked: match a supplier invoice to this delivery note first.'}</p>
      <button class="sc-btn ${invMatched ? 'green' : 'ghost'}" data-act="creategr" ${invMatched ? '' : 'disabled'}>🏬 Create Goods Receipt</button></div>`;
  }

  mount(root, `
    <div class="sc-card-h"><h3>🚚 ${esc(dn.dn_number)}</h3><div class="sc-spacer"></div>
      ${statusBadge(dn.status)}<button class="sc-btn sm ghost" style="margin-left:10px" data-act="back">← Delivery Notes</button></div>
    <div class="sc-card"><div class="sc-form-grid">
      <div class="sc-field"><label>PO</label><input class="sc-input" readonly value="${esc((dn.order && dn.order.order_number) || '')}"></div>
      <div class="sc-field"><label>PO Reference (printed)</label><input class="sc-input" readonly value="${esc(dn.po_reference || '—')}"></div>
      <div class="sc-field"><label>DN Date</label><input class="sc-input" readonly value="${esc(dn.dn_date || '—')}"></div>
      <div class="sc-field"><label>Supplier</label><input class="sc-input" readonly value="${esc(dn.supplier || '—')}"></div>
      <div class="sc-field"><label>Total Cartons</label><input class="sc-input" readonly value="${esc(String(dn.total_cartons ?? '—'))}"></div>
      <div class="sc-field"><label>Warehouse</label><input class="sc-input" readonly value="${esc((dn.order && dn.order.warehouse) || '—')}"></div>
    </div></div>
    <div class="erp-grid-2">${invoiceCard}${grCard}</div>
    <div class="sc-card"><div class="sc-card-h"><h3>📦 Lines &amp; Batches</h3><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">shelf life computed live from batch dates</span></div>
      <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Batch / Lot</th><th>Expiry</th><th>Mfg</th><th class="num">Cases</th><th>Remaining shelf life</th><th>QC</th></tr></thead><tbody>${lineRows}</tbody></table></div></div>`);

  wire(root, {
    back: () => ctx.navigate('delivery-notes'),
    invoice: () => openInvoiceModal(dn, byRoshen, byCode, () => renderDnDetail(root, ctx, dnId)),
    rematch: async () => { try { const r = await matchInvoiceToDeliveryNote(inv.id); toast('Invoice ' + r.status, r.matched ? 'ok' : 'info'); renderDnDetail(root, ctx, dnId); } catch (e) { toast(e.message || String(e), 'err'); } },
    creategr: async () => {
      try { const g = await createGoodsReceiptFromDeliveryNote(dn.id, { warehouse: dn.order && dn.order.warehouse, createdBy: 'dn-detail' }); toast('Goods receipt ' + g.grn_number + ' created', 'ok'); ctx.navigate('goods-receiving', { view: 'detail', grId: g.id }); }
      catch (e) { toast(e.message || String(e), 'err'); }
    },
    opengr: ({ id }) => ctx.navigate('goods-receiving', { view: 'detail', grId: id }),
  });
}

async function openInvoiceModal(dn, byRoshen, byCode, onDone) {
  let prices = {};
  try { prices = await priceIndex(dn.order_id); } catch (e) { /* fall back to zero */ }
  modal('Create & match supplier invoice', `
    <p style="font-size:12.5px;color:var(--text-secondary);margin-top:0">Lines are taken from this delivery note at the PO case price. Enter the supplier's invoice number.</p>
    <div class="sc-form-grid">
      <div class="sc-field"><label>Invoice Number</label><input id="si-num" class="sc-input" placeholder="e.g. INV-1234"></div>
      <div class="sc-field"><label>Invoice Date</label><input id="si-date" class="sc-input" type="date" value="${esc(today())}"></div>
    </div>`, [
    { label: 'Cancel', cls: 'ghost' },
    {
      label: 'Create & Match', cls: 'primary', onClick: async () => {
        const number = (document.getElementById('si-num').value || '').trim();
        const date = document.getElementById('si-date').value || null;
        if (!number) return toast('Enter an invoice number', 'err');
        try {
          const lines = invoiceLinesFromDeliveryNote(dn.items, prices);
          const created = await createSupplierInvoice({
            orderId: dn.order_id, deliveryNoteId: dn.id,
            header: { invoice_number: number, invoice_date: date, supplier: dn.supplier }, lines, createdBy: 'dn-detail',
          });
          const r = await matchInvoiceToDeliveryNote(created.id);
          toast('Invoice ' + r.status + (r.summary.mismatches ? ' (' + r.summary.mismatches + ' mismatch)' : ''), r.matched ? 'ok' : 'info');
          onDone();
        } catch (e) { toast('Failed: ' + (e.message || e), 'err'); }
      },
    },
  ]);
}
