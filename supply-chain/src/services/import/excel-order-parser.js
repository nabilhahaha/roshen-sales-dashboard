// Excel order parser — reads the first worksheet, detects the header row, and
// returns the columns + data rows. Pure aside from the injected XLSX lib.

const isBlank = (v) => v == null || String(v).trim() === '';
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
  const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: null });
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

  const rows = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    if (row.every(isBlank)) continue; // ignore completely blank rows
    const obj = {};
    columns.forEach((c) => { const v = row[c.idx]; obj[c.idx] = isBlank(v) ? '' : String(v).trim(); });
    rows.push(obj);
  }

  return { sheetName, headerRowIndex, columns, rows };
}
