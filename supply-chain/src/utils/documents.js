// Print + Excel export for orders and PIs. Pure IO given already-loaded data.
import { esc, money, qty, today } from './format.js';

function kv(obj) {
  return `<div class="kv">${Object.keys(obj).map((k) =>
    `<div><span>${esc(k)}</span><b>${esc(obj[k] == null ? '—' : obj[k])}</b></div>`).join('')}</div>`;
}
function printDoc(title, meta, table) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1a2942;padding:32px;max-width:1000px;margin:auto}
    h1{font-size:20px;margin:0 0 4px}.sub{color:#e8590c;font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase}
    .kv{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}
    .kv div{border:1px solid #e4e8ef;border-radius:8px;padding:8px 10px}.kv span{display:block;font-size:10px;color:#7c8b9e;text-transform:uppercase;letter-spacing:.5px}.kv b{font-size:13px}
    table{width:100%;border-collapse:collapse;font-size:12px;margin-top:10px}th,td{border:1px solid #e4e8ef;padding:7px 9px;text-align:left}th{background:#f4f6fa;font-size:10px;text-transform:uppercase;letter-spacing:.5px}
    .r{text-align:right}tfoot td{font-weight:800;background:#faf6f2}@media print{body{padding:0}}
  </style></head><body><div class="sub">Roshen / Relia Supply Chain</div><h1>${esc(title)}</h1>${meta}${table}
    <p style="margin-top:24px;font-size:11px;color:#7c8b9e">Generated ${esc(today())}</p></body></html>`;
}
function openPrint(html) {
  const w = window.open('', '_blank');
  if (!w) return false;
  w.document.open(); w.document.write(html); w.document.close();
  setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 350);
  return true;
}
function writeXlsx(aoa, filename, sheet) {
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheet || 'Sheet1');
  XLSX.writeFile(wb, filename);
}

export function printOrder(order) {
  const its = (order.supply_order_items || []).slice().sort((a, b) => a.id - b.id);
  const cases = its.reduce((a, b) => a + Number(b.ordered_cases || 0), 0);
  const total = its.reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0);
  const rows = its.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.item_code)}</td><td>${esc(l.roshen_id || '')}</td><td>${esc(l.item_description || '')}</td><td class="r">${money(l.price_case)}</td><td class="r">${qty(l.ordered_cases)}</td><td class="r">${money(Number(l.ordered_cases) * Number(l.price_case))}</td></tr>`).join('');
  return openPrint(printDoc('Purchase Order ' + order.order_number,
    kv({ 'Order Number': order.order_number, 'Order Date': order.order_date, Supplier: order.supplier, Warehouse: order.warehouse || '—', 'Expected Arrival': order.expected_arrival || '—', Status: order.status }),
    `<table><thead><tr><th>#</th><th>Item Code</th><th>Roshen ID</th><th>Description</th><th class="r">Price/Case</th><th class="r">Cases</th><th class="r">Line Total</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="5" class="r">TOTAL</td><td class="r">${qty(cases)}</td><td class="r">${money(total)} SAR</td></tr></tfoot></table>`));
}

export function exportOrderExcel(order) {
  const its = (order.supply_order_items || []).slice().sort((a, b) => a.id - b.id);
  const aoa = [['Purchase Order', order.order_number], ['Order Date', order.order_date], ['Supplier', order.supplier], ['Warehouse', order.warehouse || ''], ['Expected Arrival', order.expected_arrival || ''], ['Status', order.status], [],
    ['#', 'Item Code', 'Roshen ID', 'Description', 'Price/Case (SAR)', 'Ordered Cases', 'Line Total (SAR)']];
  its.forEach((l, i) => aoa.push([i + 1, l.item_code, l.roshen_id || '', l.item_description || '', Number(l.price_case), Number(l.ordered_cases), Number(l.ordered_cases) * Number(l.price_case)]));
  aoa.push([]); aoa.push(['', '', '', 'TOTAL', '', its.reduce((a, b) => a + Number(b.ordered_cases || 0), 0), its.reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0)]);
  writeXlsx(aoa, 'Order_' + order.order_number + '.xlsx', 'Order');
}

export function printPi(pi, orderNumber) {
  const its = (pi.proforma_invoice_items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  const rows = its.map((l) => `<tr><td>${esc(l.line_no || '')}</td><td>${esc(l.pi_item_code || '')}</td><td>${esc(l.roshen_id || '')}</td><td>${esc(l.description || '')}</td><td class="r">${qty(l.box_pcs)}</td><td class="r">${money(l.case_price)}</td><td class="r">${money(l.taxable_amount)}</td><td class="r">${qty(l.vat_percent)}%</td><td class="r">${money(l.line_total)}</td></tr>`).join('');
  return openPrint(printDoc('Proforma Invoice ' + (pi.pi_number || ''),
    kv({ 'PI Number': pi.pi_number, 'PI Date': pi.pi_date, Supplier: pi.supplier, Customer: pi.customer, Currency: pi.currency, 'Linked Order': orderNumber || '—', Status: pi.status }),
    `<table><thead><tr><th>#</th><th>Code</th><th>Roshen</th><th>Description</th><th class="r">Cases</th><th class="r">Price/Case</th><th class="r">Taxable</th><th class="r">VAT%</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="6" class="r">TOTAL</td><td class="r">${money(pi.total_taxable)}</td><td class="r"></td><td class="r">${money(pi.grand_total)} ${esc(pi.currency || '')}</td></tr></tfoot></table>`));
}

// Printable Delivery Note. dn = getDeliveryNote() shape (items → batches).
export function printDeliveryNote(dn) {
  const rows = (dn.items || []).flatMap((it) => {
    const batches = it.batches && it.batches.length ? it.batches : [{}];
    return batches.map((b, i) => `<tr>
      <td>${i === 0 ? esc(it.item_code || '') : ''}</td>
      <td>${i === 0 ? esc(it.roshen_id || '') : ''}</td>
      <td>${i === 0 ? esc(it.description || '') : ''}</td>
      <td>${esc(b.batch_no || '—')}</td>
      <td>${esc(b.manufacturing_date || '—')}</td>
      <td>${esc(b.expiry_date || '—')}</td>
      <td class="r">${qty(b.cases)}</td>
      <td class="r">${b.boxes == null ? '' : qty(b.boxes)}</td>
      <td class="r">${b.pieces == null ? '' : qty(b.pieces)}</td>
      <td>${esc(b.qc_status || '')}</td></tr>`);
  }).join('');
  const totalCases = (dn.items || []).reduce((a, it) => a + (it.batches || []).reduce((x, b) => x + Number(b.cases || 0), 0), 0);
  return openPrint(printDoc('Delivery Note ' + (dn.dn_number || ''),
    kv({ 'DN Number': dn.dn_number, 'DN Date': dn.dn_date, Supplier: dn.supplier, 'PO Reference': dn.po_reference || '—', 'Linked Order': (dn.order && dn.order.order_number) || '—', Warehouse: (dn.order && dn.order.warehouse) || '—', Status: dn.status }),
    `<table><thead><tr><th>Item Code</th><th>Roshen</th><th>Description</th><th>Batch/Lot</th><th>Mfg Date</th><th>Expiry</th><th class="r">Cases</th><th class="r">Boxes</th><th class="r">Pcs</th><th>QC</th></tr></thead><tbody>${rows}</tbody><tfoot><tr><td colspan="6" class="r">TOTAL CARTONS</td><td class="r">${qty(totalCases)}</td><td colspan="3"></td></tr></tfoot></table>`));
}

// Printable supplier invoice / credit note / debit note. inv = getInvoice() shape.
export function printSupplierInvoice(inv) {
  const its = (inv.items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  const title = (inv.doc_type === 'credit_note' ? 'Credit Note ' : inv.doc_type === 'debit_note' ? 'Debit Note ' : 'Supplier Invoice ') + (inv.invoice_number || '');
  const z = inv.zatca || {};
  const rows = its.map((l) => `<tr>
    <td>${esc(l.line_no || '')}</td><td>${esc(l.roshen_id || l.item_code || '')}</td><td>${esc(l.description || '')}</td>
    <td class="r">${qty(l.invoiced_cases)}</td><td class="r">${money(l.case_price)}</td>
    <td class="r">${money(l.taxable_amount)}</td><td class="r">${l.vat_percent == null ? '' : qty(l.vat_percent) + '%'}</td>
    <td class="r">${money(l.vat_amount)}</td><td class="r">${money(l.line_total)}</td></tr>`).join('');
  return openPrint(printDoc(title,
    kv({
      'Document': inv.doc_type === 'credit_note' ? 'Credit Note' : inv.doc_type === 'debit_note' ? 'Debit Note' : 'Tax Invoice',
      'Number': inv.invoice_number, 'Invoice Date': inv.invoice_date || '—', 'Supply Date': inv.supply_date || '—',
      Supplier: inv.supplier || '—', Buyer: inv.buyer || '—', 'PO Reference': (inv.order && inv.order.order_number) || '—',
      'DN Reference': inv.dn_reference || '—', 'Seller VAT': z.seller_vat || '—', 'Buyer VAT': z.buyer_vat || '—',
      Currency: inv.currency || 'SAR', Status: inv.status,
    }),
    `<table><thead><tr><th>#</th><th>Roshen / Code</th><th>Description</th><th class="r">Cases</th><th class="r">Price/Case</th><th class="r">Taxable</th><th class="r">VAT%</th><th class="r">VAT</th><th class="r">Total</th></tr></thead><tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5" class="r">TOTAL</td><td class="r">${money(inv.total_taxable)}</td><td class="r"></td><td class="r">${money(inv.total_vat)}</td><td class="r">${money(inv.grand_total)} ${esc(inv.currency || 'SAR')}</td></tr></tfoot></table>`));
}

export function exportErrorReport(failed, filename) {
  const aoa = [['Excel Row', 'Type', 'Item Code', 'Roshen ID', 'Quantity', 'Reason']];
  (failed || []).forEach((f) => aoa.push([f.rowNo || '', f.type || '', f.code || '', f.roshen || '', f.qty || '', f.reason || '']));
  const base = (filename || 'import').replace(/\.[^.]+$/, '').replace(/[^\w.-]/g, '_');
  writeXlsx(aoa, 'Import_Errors_' + base + '.xlsx', 'Errors');
}

export function exportPiExcel(pi, orderNumber) {
  const its = (pi.proforma_invoice_items || []).slice().sort((a, b) => (a.line_no || 0) - (b.line_no || 0));
  const aoa = [['Proforma Invoice', pi.pi_number || ''], ['PI Date', pi.pi_date || ''], ['Supplier', pi.supplier || ''], ['Customer', pi.customer || ''], ['Currency', pi.currency || ''], ['Linked Order', orderNumber || ''], ['Status', pi.status], [],
    ['#', 'PI Code', 'Roshen ID', 'Item Code', 'Description', 'UOM', 'Units', 'Cases', 'Unit Price', 'Case Price', 'Discount%', 'Taxable', 'VAT%', 'VAT Amt', 'Line Total', 'Match']];
  its.forEach((l) => aoa.push([l.line_no, l.pi_item_code || '', l.roshen_id || '', l.item_code || '', l.description || '', l.uom || '', Number(l.quantity), Number(l.box_pcs), Number(l.unit_price), Number(l.case_price), l.discount_percent || 0, Number(l.taxable_amount), l.vat_percent || 0, Number(l.vat_amount), Number(l.line_total), l.match_status || '']));
  aoa.push([]); aoa.push(['', '', '', '', '', '', '', '', '', '', 'TOTAL', Number(pi.total_taxable || 0), '', Number(pi.total_vat || 0), Number(pi.grand_total || 0), '']);
  writeXlsx(aoa, 'PI_' + (pi.pi_number || 'export').replace(/[^\w.-]/g, '_') + '.xlsx', 'Proforma Invoice');
}
