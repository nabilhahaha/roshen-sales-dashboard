// Excel order parser — reads the first worksheet, detects the header row, and
// returns the columns + data rows. Pure aside from the injected XLSX lib.
//
// Numbers are taken from the TYPED cell value, never from the displayed text:
// a cell storing 1260 shown as "1.260" (EU format) or "1,260" (US format) is
// returned as the number 1260. Text cells that carry written numbers keep
// their string and the document's number locale (detected from all its
// strings) is returned so downstream parsing interprets them correctly.
import { detectNumberLocale } from '../../utils/format.js';

const isBlank = (v) => v == null || String(v).trim() === '';
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// interpret a display string under one locale (for typed-value ↔ display pairs)
function detectPairValue(w, locale) {
  let s = String(w).replace(/[^0-9.,\-]/g, '');
  if (!s) return null;
  if (locale === 'eu') s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
const colLetter = (i) => {
  let s = '', n = i;
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
};

// Header row = the row (within the first 20) with the most non-empty cells,
// requiring at least two and at least one non-numeric label.
function detectHeaderRow(grid) {
  let best = 0, bestScore = -1;
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const row = grid[r] || [];
    const nonEmpty = row.filter((c) => !isBlank(c));
    const textCells = nonEmpty.filter((c) => isNaN(Number(String(c).replace(/[, ]/g, ''))));
    if (nonEmpty.length >= 2 && textCells.length >= 1) {
      const score = nonEmpty.length + textCells.length * 0.5;
      if (score > bestScore) { bestScore = score; best = r; }
    }
  }
  return best;
}

export function parseOrderWorkbook(arrayBuffer, XLSX) {
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  // display text (labels, samples, locale evidence) + typed values (data)
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
  const typed = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  if (!grid.length) throw new Error('The worksheet is empty.');

  const headerRowIndex = detectHeaderRow(grid);
  const headerRow = grid[headerRowIndex] || [];
  const width = grid.reduce((m, r) => Math.max(m, (r || []).length), headerRow.length);

  const columns = [];
  for (let i = 0; i < width; i++) {
    const raw = headerRow[i];
    const label = isBlank(raw) ? `Column ${colLetter(i)}` : String(raw).trim();
    // first non-empty value below the header, as a sample
    let sample = '';
    for (let r = headerRowIndex + 1; r < grid.length; r++) {
      const v = (grid[r] || [])[i];
      if (!isBlank(v)) { sample = String(v).trim(); break; }
    }
    columns.push({ idx: i, label, sample });
  }

  // The document's written-number locale. STRONGEST evidence: cells that are
  // typed numbers with a separator in their DISPLAY text — the pair proves how
  // this document writes numbers (v=2080 shown as "2,080" ⇒ comma = thousands),
  // which then also decides its TEXT numbers ("1,715" ⇒ 1715, not 1.715).
  // Fallback: pattern evidence from the document's strings.
  let euPair = 0, usPair = 0;
  for (let r = 0; r < grid.length; r++) {
    const wRow = grid[r] || [], tRow = typed[r] || [];
    for (let i = 0; i < wRow.length; i++) {
      const v = tRow[i], w = wRow[i];
      if (typeof v !== 'number' || !isFinite(v) || typeof w !== 'string' || !/[.,]/.test(w)) continue;
      const asUs = detectPairValue(w, 'us'), asEu = detectPairValue(w, 'eu');
      if (asUs === v && asEu !== v) usPair++;
      else if (asEu === v && asUs !== v) euPair++;
    }
  }
  const numberLocale = usPair > euPair ? 'us' : euPair > usPair ? 'eu'
    : detectNumberLocale(grid.flatMap((r) => (r || []).filter((v) => typeof v === 'string')));

  // A data cell's value is its TYPED content: a numeric cell is the number
  // itself (immune to display formatting like "1.260" for 1260), a date cell
  // becomes an ISO day, and only genuine text stays a string.
  const cellValue = (rawV, wV) => {
    if (typeof rawV === 'number' && isFinite(rawV)) return rawV;
    if (rawV instanceof Date && !isNaN(rawV)) return isoDay(rawV);
    return isBlank(wV) ? '' : String(wV).trim();
  };

  const rows = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row.every(isBlank)) continue; // ignore completely blank rows
    const obj = { __row: r + 1 }; // 1-based Excel row number, for error reporting
    columns.forEach((c) => { obj[c.idx] = cellValue((typed[r] || [])[c.idx], row[c.idx]); });
    rows.push(obj);
  }

  return { sheetName, headerRowIndex, columns, rows, numberLocale };
}
