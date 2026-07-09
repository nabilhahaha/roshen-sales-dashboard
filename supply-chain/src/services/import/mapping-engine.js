// Generic dynamic column-mapping engine (pure + localStorage).
//
// The same engine drives the Purchase-Order import and the Delivery-Note
// import — each supplies its own field catalogue, heuristic rules and storage
// key. No document-specific logic lives here.
//
//   config = { fields: [{key,label,required}], rules: [[regex, fieldKey]],
//              storeKey: 'localStorage key' }

// Heuristic auto-mapping from column header text.
export function suggestMapping(columns, config) {
  const byIdx = {};
  const used = new Set();
  columns.forEach((c) => {
    for (const [re, field] of config.rules) {
      if (used.has(field)) continue;
      if (re.test(c.label)) { byIdx[c.idx] = field; used.add(field); break; }
    }
  });
  return byIdx;
}

// idx->field  +  columns  ->  label->field  (for saving)
export function idxToLabelMap(mapByIdx, columns) {
  const out = {};
  columns.forEach((c) => { const f = mapByIdx[c.idx]; if (f && f !== 'ignore') out[c.label] = f; });
  return out;
}

// saved label->field  +  columns  ->  idx->field
export function mappingToIdx(mapByLabel, columns) {
  const byIdx = {};
  columns.forEach((c) => {
    const field = mapByLabel[c.label] ||
      mapByLabel[Object.keys(mapByLabel).find((k) => k.toLowerCase() === c.label.toLowerCase())];
    if (field) byIdx[c.idx] = field;
  });
  return byIdx;
}

export function requiredMissing(mapByIdx, config) {
  const mapped = new Set(Object.values(mapByIdx));
  return config.fields.filter((f) => f.required && !mapped.has(f.key)).map((f) => f.label);
}

// ---- named-mapping persistence (per browser) ------------------------
export function listMappings(config) {
  try { return JSON.parse(localStorage.getItem(config.storeKey) || '[]'); } catch (e) { return []; }
}
export function saveMapping(name, mapByLabel, config) {
  const all = listMappings(config).filter((m) => m.name !== name);
  all.push({ name, map: mapByLabel, savedAt: Date.now() });
  try { localStorage.setItem(config.storeKey, JSON.stringify(all)); } catch (e) {}
}
export function deleteMapping(name, config) {
  try { localStorage.setItem(config.storeKey, JSON.stringify(listMappings(config).filter((m) => m.name !== name))); } catch (e) {}
}
// A saved mapping whose mapped column labels all exist in this file.
export function findMatchingMapping(columns, config) {
  const set = new Set(columns.map((c) => c.label.toLowerCase()));
  return listMappings(config).find((m) =>
    Object.keys(m.map).length > 0 &&
    Object.keys(m.map).every((label) => set.has(label.toLowerCase()))) || null;
}
