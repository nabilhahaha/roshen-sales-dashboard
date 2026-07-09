// Order-mapping service — the ERP field catalogue, auto-suggestion, and
// persistence of named column mappings (reused on the next import).
// Persisted in localStorage (per browser) — no schema change required.

export const ERP_FIELDS = [
  { key: 'item_code', label: 'Item Code', required: true },
  { key: 'roshen_id', label: 'Roshen ID', required: true },
  { key: 'quantity', label: 'Quantity', required: true },
  { key: 'description', label: 'Description' },
  { key: 'unit_price', label: 'Unit Price' },
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

// Heuristic auto-mapping from column header text.
const RULES = [
  [/item\s*code|^sku$|article/i, 'item_code'],
  [/roshen/i, 'roshen_id'],
  [/qty|quantity|cases|ordered/i, 'quantity'],
  [/desc|item\s*name|product|name/i, 'description'],
  [/price|unit\s*price|rate/i, 'unit_price'],
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
