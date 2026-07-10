// Order-mapping service — the ERP field catalogue, auto-suggestion, and
// persistence of named column mappings (reused on the next import).
// Persisted in localStorage (per browser) — no schema change required.

// Field catalogue — mirrors the columns of the real supplier PI document
// (No. / Item Code / Code / Item name / Unit of measure / Number of Units /
// Box,Pcs / Price / Discount % / Price after Discount / Taxable / VAT% /
// VAT Amt / Amount).
export const ERP_FIELDS = [
  { key: 'item_code', label: 'Item Code', required: true },
  { key: 'roshen_id', label: 'Roshen Code', required: true },
  { key: 'quantity', label: 'Ordered Qty (Box/Pcs)', required: true },
  { key: 'description', label: 'Item Description' },
  { key: 'uom', label: 'Unit of Measure' },
  { key: 'units_qty', label: 'Number of Units' },
  { key: 'unit_price', label: 'Unit Price' },
  { key: 'discount_percent', label: 'Discount %' },
  { key: 'net_unit_price', label: 'Price after Discount' },
  { key: 'taxable_amount', label: 'Taxable Amount' },
  { key: 'vat_percent', label: 'VAT %' },
  { key: 'vat_amount', label: 'VAT Amount' },
  { key: 'amount', label: 'Total Amount' },
  { key: 'notes', label: 'Notes' },
];

const KEY = 'roshen_sc_order_mappings_v1';

export function listMappings() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return []; }
}
export function saveMapping(name, mapByLabel) {
  const all = listMappings().filter((m) => m.name !== name);
  all.push({ name, map: mapByLabel, savedAt: Date.now() });
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {}
}
export function deleteMapping(name) {
  try { localStorage.setItem(KEY, JSON.stringify(listMappings().filter((m) => m.name !== name))); } catch (e) {}
}

// Find a saved mapping whose mapped column labels all exist in this file.
export function findMatchingMapping(columns) {
  const set = new Set(columns.map((c) => c.label.toLowerCase()));
  return listMappings().find((m) =>
    Object.keys(m.map).length > 0 && Object.keys(m.map).every((label) => set.has(label.toLowerCase()))) || null;
}

// Convert a saved label->field map into an idx->field map for the given columns.
export function mappingToIdx(mapByLabel, columns) {
  const byIdx = {};
  columns.forEach((c) => {
    const field = mapByLabel[c.label] || mapByLabel[Object.keys(mapByLabel).find((k) => k.toLowerCase() === c.label.toLowerCase())];
    if (field) byIdx[c.idx] = field;
  });
  return byIdx;
}

// Heuristic auto-mapping from column header text. Order matters — the more
// specific document columns (Price after Discount, VAT Amt, Taxable) must
// claim their headers before the generic price/amount rules run.
const RULES = [
  [/item\s*code|^sku$|article/i, 'item_code'],
  [/roshen|^code$/i, 'roshen_id'],
  [/unit\s*of|measure|^uom$/i, 'uom'],
  [/number\s*of\s*units/i, 'units_qty'],
  [/box|carton|ctn|cases|qty|quantity|ordered/i, 'quantity'],
  [/desc|item\s*name|product|name/i, 'description'],
  [/after\s*discount|net\s*price/i, 'net_unit_price'],
  [/discount/i, 'discount_percent'],
  [/taxable/i, 'taxable_amount'],
  [/vat\s*amt|vat\s*amount/i, 'vat_amount'],
  [/vat\s*%|vat%|^vat\b/i, 'vat_percent'],
  [/price|rate/i, 'unit_price'],
  [/amount|total/i, 'amount'],
  [/note|remark|comment/i, 'notes'],
];
export function suggestMapping(columns) {
  const byIdx = {};
  const used = new Set();
  columns.forEach((c) => {
    for (const [re, field] of RULES) {
      if (used.has(field)) continue;
      if (re.test(c.label)) { byIdx[c.idx] = field; used.add(field); break; }
    }
  });
  return byIdx;
}

// idx->field map + columns -> label->field map (for saving).
export function idxToLabelMap(mapByIdx, columns) {
  const out = {};
  columns.forEach((c) => { const f = mapByIdx[c.idx]; if (f && f !== 'ignore') out[c.label] = f; });
  return out;
}
