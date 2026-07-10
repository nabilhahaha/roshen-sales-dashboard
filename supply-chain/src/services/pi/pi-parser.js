// Dynamic Roshen Proforma-Invoice parser.
//
// Pure functions — no DOM, no network. Detects the header block and the items
// table dynamically (no hard-coded row/column numbers) so it keeps working if
// the supplier inserts rows or shifts the template. Input is a sheet grid
// (array-of-arrays of strings) as produced by XLSX.utils.sheet_to_json(ws,
// { header: 1, raw: false, defval: null }).
//
// Verified against a real Roshen PI (KS-397/2026): correct header fields, all
// 13 line items, and matching net / VAT / grand totals.

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const normKey = (s) => norm(s).toLowerCase();

// European / mixed number parsing: "4050,00" -> 4050, "386 228,96" -> 386228.96.
// The document's written-number locale is detected once per parse (parseGrid)
// so a lone separator ("1.260" = 1260 in an EU document) is never misread as a
// decimal point. Numbers typed as numbers pass through untouched.
import { detectNumberLocale } from '../../utils/format.js';
let DOC_LOCALE = null;   // set per parseGrid() call from the document itself
export function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/ /g, ' ').trim();
  if (!s) return null;
  s = s.replace(/[^0-9.,\-\s]/g, '').replace(/\s/g, '');
  if (!s) return null;
  if (DOC_LOCALE === 'eu') s = s.replace(/\./g, '').replace(',', '.');
  else if (DOC_LOCALE === 'us') s = s.replace(/,/g, '');
  else {
    const hasComma = s.indexOf(',') >= 0;
    const hasDot = s.indexOf('.') >= 0;
    if (hasComma && hasDot) {
      // both separators: the LAST one is the decimal point in either format
      if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
      else s = s.replace(/\./g, '').replace(',', '.');
    } else if (hasComma) s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export function findHeaderRow(grid) {
  for (let r = 0; r < grid.length; r++) {
    const cells = (grid[r] || []).map(normKey);
    const hasName = cells.some((c) => /item\s*name|item name|description|наименование/.test(c));
    const hasPrice = cells.some((c) => /price/.test(c));
    const hasQty = cells.some((c) => /number of\s*units|quantity|\bqty\b|units|box/.test(c));
    const hasNo = cells.some((c) => /^no\.?$/.test(c) || /^№$/.test(c));
    if (hasName && hasPrice && (hasQty || hasNo)) return r;
  }
  return -1;
}

export function mapColumns(headerRow) {
  const cells = (headerRow || []).map(normKey);
  const find = (test, exclude) => {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c || (exclude && exclude.test(c))) continue;
      if (test.test(c)) return i;
    }
    return -1;
  };
  return {
    no: find(/^no\.?$|^№$/),
    itemCode: find(/item\s*code/),
    roshenId: find(/^code$/),
    name: find(/item\s*name|item name|description|наименование/),
    uom: find(/unit of|measure|uom|од\.?вим/),
    quantity: find(/number of\s*units|quantity|units|\bqty\b/, /box/),
    boxPcs: find(/box|pcs/),
    price: find(/price/, /discount|after|vat/),
    discount: find(/discount/),
    netPrice: find(/after\s*discount|net\s*price/),
    taxable: find(/taxable/),
    vatPct: find(/vat\s*%|vat%|^vat$/),
    vatAmt: find(/vat\s*amt|vat amount|vat\s*,/),
    amount: find(/^amount|line\s*total|^amount,/, /vat|taxable/),
  };
}

// Find "Label | value" pairs anywhere on the sheet. valueTest (optional)
// filters candidate values — e.g. require a digit so a bilingual document's
// Arabic mirror-label in the same row is never mistaken for the value.
function findLabelled(grid, tests, valueTest) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const key = normKey(row[c]);
      if (!key) continue;
      if (tests.some((t) => t.test(key))) {
        for (let c2 = c + 1; c2 < row.length; c2++) {
          const v = norm(row[c2]);
          if (v !== '' && (!valueTest || valueTest.test(v))) return { value: v, row: r, col: c2 };
        }
      }
    }
  }
  return null;
}

function parseDate(str) {
  if (!str) return null;
  const s = norm(str);
  let m = s.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  m = s.match(/(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return null;
}

export function parseGrid(grid) {
  // detect the document's written-number locale from all its cell strings
  DOC_LOCALE = detectNumberLocale(grid.flatMap((r) => (r || []).filter((v) => typeof v === 'string')));
  const hIdx = findHeaderRow(grid);
  if (hIdx < 0) throw new Error('Could not locate the items table header row in this Excel file.');
  const cols = mapColumns(grid[hIdx]);

  const piNo = findLabelled(grid, [/proforma\s*invoice/, /^pi\s*(no|number|#)/, /invoice\s*(no|number|#)/]);
  const dt = findLabelled(grid, [/^date:?$/, /invoice\s*date/, /pi\s*date/]);
  const cust = findLabelled(grid, [/^customer:?$/, /bill\s*to/], /[A-Za-z]/);
  const vat = findLabelled(grid, [/^vat\s*(no|number|№|no\.)/], /\d/);
  const cr = findLabelled(grid, [/^cr\s*number|^c\.?r\.?\s*no/], /\d/);
  const custVat = findLabelled(grid, [/customer\s*vat/], /\d/);
  const custCr = findLabelled(grid, [/customer\s*cr/], /\d/);
  const shortAddr = findLabelled(grid, [/short\s*address/], /[A-Za-z0-9]/);
  const salesman = findLabelled(grid, [/salesman/], /[A-Za-z]{2,}/);
  const pay = findLabelled(grid, [/payment\s*terms?/]);
  const del = findLabelled(grid, [/delivery\s*terms?/]);

  // Document type — the title cell itself (e.g. PROFORMA INVOICE).
  let documentType = null;
  outer: for (let r = 0; r < grid.length; r++) {
    for (const cell of grid[r] || []) {
      const t = norm(cell);
      if (/^(proforma|commercial|tax)\s+invoice$|^purchase\s+order$/i.test(t)) { documentType = t; break outer; }
    }
  }

  let supplier = null;
  for (let r = 0; r < Math.min(grid.length, 8) && !supplier; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const t = norm(row[c]);
      if (t && /[A-Za-z]{3,}/.test(t) && !/vat|cr number|proforma/i.test(t)) { supplier = t.replace(/^company[:\s]+/i, ''); break; }
    }
  }

  // Supplier address — a top-of-document cell that reads like an address.
  let supplierAddress = null;
  for (let r = 0; r < Math.min(grid.length, 12) && !supplierAddress; r++) {
    for (const cell of grid[r] || []) {
      const t = norm(cell);
      if (t && /office|street|\bstr\b|dist\.?|zip|p\.?o\.?\s*box|road|building/i.test(t) && !/short\s*address/i.test(t)) { supplierAddress = t; break; }
    }
  }

  // Bank + IBAN — a cell starting with "IBAN"; the bank name is the row's label cell.
  let supplierBank = null, supplierIban = null;
  outerBank: for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const t = norm(row[c]);
      const m = t.match(/^iban[:\s]*([A-Z]{2}[0-9A-Z ]{8,})/i);
      if (m) {
        supplierIban = m[1].replace(/\s+(SAR|USD|EUR|AED)$/i, '').trim();
        for (let c2 = 0; c2 < c; c2++) { const b = norm(row[c2]); if (b && /[A-Za-z]{3,}/.test(b)) { supplierBank = b; break; } }
        break outerBank;
      }
    }
  }

  let currency = 'SAR';
  const ph = (cols.price >= 0 ? norm(grid[hIdx][cols.price]) : '') + ' ' + (cols.amount >= 0 ? norm(grid[hIdx][cols.amount]) : '');
  const cm = ph.match(/\b(SAR|USD|EUR|AED|UAH|GBP)\b/i);
  if (cm) currency = cm[1].toUpperCase();

  const items = [];
  let totalsRow = null;
  for (let r = hIdx + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (/\btotal\b/.test(row.map(normKey).join(' '))) { totalsRow = row; break; }
    const roshenId = cols.roshenId >= 0 ? norm(row[cols.roshenId]) : '';
    const itemCode = cols.itemCode >= 0 ? norm(row[cols.itemCode]) : '';
    const name = cols.name >= 0 ? norm(row[cols.name]) : '';
    if (!name && !roshenId && !itemCode) continue;
    if (!name && parseNum(row[cols.quantity]) == null) continue;
    const q = parseNum(row[cols.quantity]);
    const box = parseNum(row[cols.boxPcs]);
    const tax = parseNum(row[cols.taxable]);
    items.push({
      line_no: parseNum(row[cols.no]) || items.length + 1,
      pi_item_code: itemCode || null,
      roshen_id: roshenId || null,
      description: name || null,
      uom: cols.uom >= 0 ? norm(row[cols.uom]) || null : null,
      quantity: q,
      box_pcs: box,
      unit_price: parseNum(row[cols.price]),
      case_price: tax != null && box ? +(tax / box).toFixed(4) : null,
      discount_percent: parseNum(row[cols.discount]),
      net_price: parseNum(row[cols.netPrice]),
      taxable_amount: tax,
      vat_percent: parseNum(row[cols.vatPct]),
      vat_amount: parseNum(row[cols.vatAmt]),
      line_total: parseNum(row[cols.amount]),
    });
  }

  const net = findLabelled(grid, [/total\s*net\s*amount/]);
  const vt = findLabelled(grid, [/total\s*vat\s*amount/]);
  const grand = findLabelled(grid, [/total\s*grand\s*amount|grand\s*total/]);
  const wt = findLabelled(grid, [/gross\s*total\s*weight|total\s*weight/]);

  let tQ = null, tB = null, tT = null, tV = null, tG = null;
  if (totalsRow) {
    tQ = parseNum(totalsRow[cols.quantity]);
    tB = parseNum(totalsRow[cols.boxPcs]);
    tT = parseNum(totalsRow[cols.taxable]);
    tV = parseNum(totalsRow[cols.vatAmt]);
    tG = parseNum(totalsRow[cols.amount]);
  }
  if (net) tT = parseNum(net.value);
  if (vt) tV = parseNum(vt.value);
  if (grand) tG = parseNum(grand.value);

  return {
    header: {
      pi_number: piNo ? piNo.value : null,
      pi_date: parseDate(dt ? dt.value : null),
      document_type: documentType,
      supplier,
      supplier_address: supplierAddress,
      supplier_short_address: shortAddr ? shortAddr.value : null,
      supplier_bank: supplierBank,
      supplier_iban: supplierIban,
      customer: cust ? cust.value : null,
      customer_vat: custVat ? custVat.value : null,
      customer_cr: custCr ? custCr.value : null,
      salesman: salesman ? salesman.value : null,
      currency,
      payment_terms: pay ? pay.value : null,
      delivery_terms: del ? del.value : null,
      vat_number: vat ? vat.value : null,
      cr_number: cr ? cr.value : null,
    },
    items,
    totals: {
      total_quantity: tQ,
      total_boxes: tB,
      total_taxable: tT,
      total_vat: tV,
      grand_total: tG,
      gross_weight: wt ? parseNum(wt.value) : null,
    },
  };
}

// Parse an uploaded File (browser) into the structured PI object.
export function parseWorkbookFromArrayBuffer(arrayBuffer, XLSX) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  return parseGrid(grid);
}
