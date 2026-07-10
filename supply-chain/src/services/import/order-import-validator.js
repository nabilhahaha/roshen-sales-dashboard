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
    const num = (f) => (has(f) ? parseNumber(get(row, f)) : null);
    if (merged[key]) {
      const m = merged[key];
      m.ordered_cases += qty; m.merges.push(qty); duplicatesMerged++;
      // additive document amounts follow the merged quantity
      ['units_qty', 'taxable_amount', 'vat_amount', 'amount'].forEach((f) => {
        const v = num(f); if (v != null) m[f] = (Number(m[f]) || 0) + v;
      });
    } else {
      const mappedDesc = get(row, 'description');
      const taxable = num('taxable_amount');
      // price per case from the document itself when it carries amounts;
      // the SKU Master price is only a fallback for bare quantity lists.
      const docCase = taxable != null && qty > 0 ? +(taxable / qty).toFixed(4) : null;
      merged[key] = {
        item_code: sku.item_code,
        roshen_id: sku.roshen_id,
        item_description: mappedDesc || sku.item_description,
        price_case: docCase != null ? docCase : Number(sku.price_case),
        ordered_cases: qty,
        uom: get(row, 'uom') || null,
        units_qty: num('units_qty'),
        unit_price: num('unit_price'),
        discount_percent: num('discount_percent'),
        net_unit_price: num('net_unit_price'),
        taxable_amount: taxable,
        vat_percent: num('vat_percent'),
        vat_amount: num('vat_amount'),
        amount: num('amount'),
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
