// Import validator — resolves mapped rows against the SKU Master, applies the
// business rules, merges duplicates, and produces order lines + a report. Pure.
//
// Resolution modes (auto-detected per row):
//  - Item Code and/or Roshen ID. Priority: Item Code, then Roshen ID.
//  - If BOTH are present and both resolve, they must refer to the SAME SKU,
//    otherwise the row is an error (conflict).
//
// Rules: quantity required and > 0; duplicate SKUs merged by summing;
// blank rows ignored; unknown (no SKU) and error (conflict / bad qty) rows are
// reported separately. O(n) with hash lookups → handles thousands of rows.
import { parseNumber } from '../../utils/format.js';

export function validateImport(rows, mapByIdx, skus) {
  const byCode = {}, byRoshen = {};
  skus.forEach((s) => {
    byCode[String(s.item_code).trim().toLowerCase()] = s;
    if (s.roshen_id) byRoshen[String(s.roshen_id).trim()] = s;
  });

  const fieldToIdx = {};
  Object.entries(mapByIdx).forEach(([idx, field]) => { if (field && field !== 'ignore') fieldToIdx[field] = Number(idx); });
  const has = (field) => fieldToIdx[field] != null;
  const get = (row, field) => (has(field) ? String(row[fieldToIdx[field]] ?? '').trim() : '');

  const merged = {};        // canonical item_code -> line (with .merges[])
  const unknown = [];
  const errors = [];
  let importedRows = 0;
  let duplicatesMerged = 0;

  rows.forEach((row) => {
    const rowNo = row.__row || '';
    const rawCode = get(row, 'item_code');
    const rawRoshen = get(row, 'roshen_id');
    const rawQty = get(row, 'quantity');
    if (!rawCode && !rawRoshen && !rawQty) return; // blank
    importedRows++;

    const skuByCode = rawCode ? byCode[rawCode.toLowerCase()] : null;
    const skuByRoshen = rawRoshen ? byRoshen[rawRoshen] : null;

    // conflict: both provided, both resolve, but to different SKUs
    if (skuByCode && skuByRoshen && skuByCode.item_code !== skuByRoshen.item_code) {
      errors.push({ rowNo, code: rawCode, roshen: rawRoshen, qty: rawQty || '—', reason: `Item Code (${skuByCode.item_code}) and Roshen ID (${rawRoshen}) refer to different SKUs` });
      return;
    }
    const sku = skuByCode || skuByRoshen; // priority: Item Code, then Roshen ID
    if (!sku) {
      const label = rawCode || rawRoshen ? 'Not found in SKU Master' : 'No Item Code or Roshen ID';
      unknown.push({ rowNo, code: rawCode || '—', roshen: rawRoshen || '—', qty: rawQty || '—', reason: label });
      return;
    }

    const qty = parseNumber(rawQty);
    if (qty == null) { errors.push({ rowNo, code: sku.item_code, roshen: sku.roshen_id || '—', qty: rawQty || '—', reason: 'Quantity is required' }); return; }
    if (!(qty > 0)) { errors.push({ rowNo, code: sku.item_code, roshen: sku.roshen_id || '—', qty: rawQty, reason: 'Quantity must be greater than zero' }); return; }

    const key = sku.item_code;
    if (merged[key]) { merged[key].ordered_cases += qty; merged[key].merges.push(qty); duplicatesMerged++; }
    else {
      const mappedDesc = get(row, 'description');
      merged[key] = {
        item_code: sku.item_code,
        roshen_id: sku.roshen_id,
        item_description: sku.item_description || mappedDesc,
        price_case: Number(sku.price_case),
        ordered_cases: qty,
        merges: [qty],
      };
    }
  });

  const lines = Object.values(merged);
  const grandTotal = lines.reduce((a, l) => a + l.ordered_cases * l.price_case, 0);
  const failed = unknown.map((u) => ({ ...u, type: 'Unknown' })).concat(errors.map((e) => ({ ...e, type: 'Error' })));

  return {
    lines,
    unknown,
    errors,
    failed,
    stats: {
      importedRows,
      matched: lines.length,
      duplicatesMerged,
      unknown: unknown.length,
      errors: errors.length,
      grandTotal,
    },
  };
}
