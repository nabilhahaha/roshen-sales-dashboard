// Delivery-Note parser — reuses the generic Excel grid parser for the line
// table (dynamic columns → mapping engine) and additionally scrapes the DN
// header fields (DN number, date, PO reference, supplier, customer) which sit
// in scattered cells above the table.
import { parseOrderWorkbook } from '../import/excel-order-parser.js';

const isBlank = (v) => v == null || String(v).trim() === '';

// Value for a labelled header cell: the next non-empty cell to its right on
// the same row, else any trailing text in the label cell itself.
import { parseDate, toISO } from '../../models/shelf-life.js';

// valueTest (optional) filters candidate values — e.g. require a digit so the
// bilingual document's Arabic mirror-label on the same row is never mistaken
// for the value (real DNs carry every label twice, EN + AR).
function headerValue(grid, labelRe, maxRow, valueTest) {
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (isBlank(cell)) continue;
      const s = String(cell).trim();
      const m = s.match(labelRe);
      if (!m) continue;
      // prefer trailing text within the same cell (e.g. "Company Sweet Stories")
      const rest = s.replace(labelRe, '').replace(/^[:\s-]+/, '').trim();
      if (rest && (!valueTest || valueTest.test(rest))) return rest;
      // else the next non-empty cell to the right on the same row
      for (let k = c + 1; k < row.length; k++) {
        if (!isBlank(row[k])) {
          const v = String(row[k]).trim();
          if (!valueTest || valueTest.test(v)) return v;
          break; // first candidate failed the test → treat as absent on this row
        }
      }
    }
  }
  return null;
}

// The document title itself (e.g. "Goods Issue Note" / "Delivery Note").
function documentTitle(grid, maxRow) {
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    for (const cell of grid[r] || []) {
      if (isBlank(cell)) continue;
      const m = String(cell).trim().match(/^(goods\s+issue\s+note|delivery\s+note)$/i);
      if (m) return m[1].replace(/\s+/g, ' ');
    }
  }
  return null;
}

// Bank row: a cell starting with "IBAN"; the bank name is the row's label cell.
function bankInfo(grid, maxRow) {
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (isBlank(row[c])) continue;
      const m = String(row[c]).trim().match(/^iban[:\s]*([A-Z]{2}[0-9A-Z ]{8,})/i);
      if (m) {
        const iban = m[1].replace(/\s+(SAR|USD|EUR|AED)$/i, '').trim();
        let bank = null;
        for (let k = 0; k < c; k++) { const b = isBlank(row[k]) ? '' : String(row[k]).trim(); if (b && /[A-Za-z]{3,}/.test(b)) { bank = b; break; } }
        return { bank, iban };
      }
    }
  }
  return { bank: null, iban: null };
}

// A top-of-document cell that reads like a street address.
function addressCell(grid, maxRow) {
  for (let r = 0; r < Math.min(grid.length, maxRow); r++) {
    for (const cell of grid[r] || []) {
      if (isBlank(cell)) continue;
      const t = String(cell).replace(/\s+/g, ' ').trim();
      if (/office|street|\bstr\b|dist\.?|zip|p\.?o\.?\s*box|road|building/i.test(t) && !/short\s*address/i.test(t)) return t;
    }
  }
  return null;
}

export function parseDeliveryNote(arrayBuffer, XLSX) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });

  const parsed = parseOrderWorkbook(arrayBuffer, XLSX); // { columns, rows, headerRowIndex }
  const maxRow = parsed.headerRowIndex + 1;

  const bank = bankInfo(grid, maxRow);
  const header = {
    dn_number: headerValue(grid, /goods\s*issue\s*note|delivery\s*note(?:\s*no\.?)?|^dn\b/i, maxRow),
    dn_date: (() => { const raw = headerValue(grid, /^date\s*:?/i, maxRow);
      const d = parseDate(raw); return d ? toISO(d) : raw; })(),
    po_reference: headerValue(grid, /purchase\s*order\s*(no\.?|number)?/i, maxRow),
    document_type: documentTitle(grid, maxRow),
    supplier: headerValue(grid, /^(?:company|supplier|vendor)\b/i, maxRow),
    supplier_vat: headerValue(grid, /^vat\s*(no\.?|number|№)/i, maxRow, /\d/),
    supplier_cr: headerValue(grid, /^cr\s*number|^c\.?r\.?\s*no/i, maxRow, /\d/),
    supplier_address: addressCell(grid, maxRow),
    supplier_short_address: headerValue(grid, /short\s*address/i, maxRow, /[A-Za-z0-9]/),
    supplier_bank: bank.bank,
    supplier_iban: bank.iban,
    customer: headerValue(grid, /^customer\b(?!\s*(cr|vat))/i, maxRow),
    customer_vat: headerValue(grid, /customer\s*vat/i, maxRow, /\d/),
    customer_cr: headerValue(grid, /customer\s*cr/i, maxRow, /\d/),
  };

  return { sheetName, header, columns: parsed.columns, rows: parsed.rows, headerRowIndex: parsed.headerRowIndex };
}
