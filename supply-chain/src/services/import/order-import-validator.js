// Import validator — resolves mapped rows against the SKU Master, applies the
// business rules, and produces order lines + a stats/report object. Pure.
//
// Rules:
//  - Item Code OR Roshen ID must exist in SKU Master (else the row is Unknown).
//  - Quantity is required and must be > 0.
//  - Duplicate SKUs are merged by summing quantities.
//  - Completely blank rows are ignored (already dropped by the parser).
import { parseNumber } from '../../utils/format.js';
import { indexByCode, indexByRoshen } from '../sku/sku.service.js';

// rows: [{ [colIdx]: value }] ; mapByIdx: { colIdx: erpField } ; skus: SKU list
export function validateImport(rows, mapByIdx, skus) {
  const byCode = {};
  indexBy(indexByCode(skus), byCode); // lowercased item_code index
  const byRoshen = indexByRoshen(skus);

  const fieldToIdx = {};
  Object.entries(mapByIdx).forEach(([idx, field]) => { if (field && field !== 'ignore') fieldToIdx[field] = Number(idx); });
  const get = (row, field) => (fieldToIdx[field] != null ? (row[fieldToIdx[field]] ?? '') : '');

  const merged = {};       // keyed by canonical SKU item_code
  const unknown = [];
  const invalid = [];
  let importedRows = 0;
  let duplicatesMerged = 0;

  rows.forEach((row) => {
    const rawCode = String(get(row, 'item_code') || '').trim();
    const rawRoshen = String(get(row, 'roshen_id') || '').trim();
    const rawQty = String(get(row, 'quantity') || '').trim();
    if (!rawCode && !rawRoshen && !rawQty) return; // blank
    importedRows++;

    let sku = rawCode ? byCode[rawCode.toLowerCase()] : null;
    if (!sku && rawRoshen) sku = byRoshen[rawRoshen];
    if (!sku) { unknown.push({ code: rawCode || '—', roshen: rawRoshen || '—', qty: rawQty || '—', reason: 'Not found in SKU Master' }); return; }

    const qty = parseNumber(rawQty);
    if (qty == null) { invalid.push({ code: sku.item_code, qty: rawQty || '—', reason: 'Quantity is required' }); return; }
    if (!(qty > 0)) { invalid.push({ code: sku.item_code, qty: rawQty, reason: 'Quantity must be greater than zero' }); return; }

    const key = sku.item_code;
    if (merged[key]) { merged[key].ordered_cases += qty; duplicatesMerged++; }
    else {
      const mappedDesc = String(get(row, 'description') || '').trim();
      merged[key] = {
        item_code: sku.item_code,
        roshen_id: sku.roshen_id,
        item_description: sku.item_description || mappedDesc,
        price_case: Number(sku.price_case),
        ordered_cases: qty,
      };
    }
  });

  const lines = Object.values(merged);
  const grandTotal = lines.reduce((a, l) => a + l.ordered_cases * l.price_case, 0);
  return {
    lines,
    unknown,
    invalid,
    stats: {
      importedRows,
      matched: lines.length,
      unknown: unknown.length,
      invalid: invalid.length,
      duplicatesMerged,
      grandTotal,
    },
  };
}

// build a lowercased item_code index from the byCode(exact) index
function indexBy(exactByCode, out) {
  Object.values(exactByCode).forEach((s) => { out[String(s.item_code).trim().toLowerCase()] = s; });
  return out;
}
