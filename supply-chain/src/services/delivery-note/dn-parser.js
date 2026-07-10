// Delivery-Note parser — reuses the generic Excel grid parser for the line
// table (dynamic columns → mapping engine) and additionally scrapes the DN
// header fields (DN number, date, PO reference, supplier, customer) which sit
// in scattered cells above the table.
import { parseOrderWorkbook } from '../import/excel-order-parser.js';

const isBlank = (v) => v == null || String(v).trim() === '';

// Value for a labelled header cell: the next non-empty cell to its right on
// the same row, else any trailing text in the label cell itself.
import { parseDate, toISO } from '../../models/shelf-life.js';

function headerValue(grid, labelRe, maxRow) {
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
      if (rest) return rest;
      // else the next non-empty cell to the right on the same row
      for (let k = c + 1; k < row.length; k++) {
        if (!isBlank(row[k])) return String(row[k]).trim();
      }
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

  const header = {
    dn_number: headerValue(grid, /goods\s*issue\s*note|delivery\s*note(?:\s*no\.?)?|^dn\b/i, maxRow),
    dn_date: (() => { const raw = headerValue(grid, /^date\s*:?/i, maxRow);
      const d = parseDate(raw); return d ? toISO(d) : raw; })(),
    po_reference: headerValue(grid, /purchase\s*order\s*(no\.?|number)?/i, maxRow),
    supplier: headerValue(grid, /^(?:company|supplier|vendor)\b/i, maxRow),
    customer: headerValue(grid, /^customer\b(?!\s*(cr|vat))/i, maxRow),
  };

  return { sheetName, header, columns: parsed.columns, rows: parsed.rows, headerRowIndex: parsed.headerRowIndex };
}
