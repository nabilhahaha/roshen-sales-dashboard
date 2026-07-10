// Reusable Shelf-Life Master Import — matching engine (pure).
//
// Roshen periodically sends a shelf-life master sheet (Product Description,
// Unit Weight, Units/Carton, Shelf Life). It carries NO Roshen ID / Item Code,
// so rows are reconciled against the existing SKU Master by:
//   1. Roshen ID / Item Code when the sheet DOES provide one (future sheets).
//   2. Otherwise description + the PACK SIGNATURE (unit weight in grams and the
//      units-per-carton), both of which the SKU Master descriptions embed
//      (e.g. "…12X350G", "…1kg*8", "…34g*200pcs").
//
// Only HIGH-confidence matches are auto-applied; everything else is returned as
// Unmatched for manual mapping. The engine never guesses. It updates nothing —
// callers apply Shelf Life Value + Unit only, leaving all other SKU fields
// (minimum remaining %, price, status, notes) untouched.
import { normRoshen } from '../../utils/format.js';

// ---- parsing --------------------------------------------------------
export function parseShelfLife(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  const m = s.match(/([\d.]+)\s*([a-z]*)/);
  if (!m) return null;
  const value = Number(m[1]);
  if (!isFinite(value) || value <= 0) return null;
  const u = m[2] || 'm';
  const unit = /^d/.test(u) ? 'Days' : /^y/.test(u) ? 'Years' : 'Months';
  return { value, unit };
}

export function parseWeightGrams(raw) {
  const s = String(raw == null ? '' : raw).toLowerCase().replace(',', '.');
  const m = s.match(/([\d.]+)\s*(kg|g)?/);
  if (!m) return null;
  let v = Number(m[1]);
  if (!isFinite(v)) return null;
  if (m[2] === 'kg' || (!m[2] && v < 10)) v *= 1000; // "1", "0.92" → kg
  return Math.round(v);
}

// Extract the pack signature from a SKU description. Recognises the formats
// the Roshen master uses — "12X350G", "8X1KG" (count × weight), "1kg*8bags",
// "200g*18", "72g*22pcs", "1kg/8" (weight × count), or a bare "185g" (weight
// only). Weights are normalised to grams. Returns null when nothing can be
// read with confidence — the caller leaves the fields empty for manual review.
export function parsePackFromDescription(desc) {
  const s = String(desc == null ? '' : desc).toLowerCase().replace(',', '.');
  const toG = (num, unit) => Math.round(Number(num) * (unit === 'kg' ? 1000 : 1));
  let m = s.match(/(\d+)\s*x\s*([\d.]+)\s*(kg|g)\b/);            // 12X350G / 8X1KG
  if (m) return { units_per_carton: Number(m[1]), unit_weight_g: toG(m[2], m[3]) };
  m = s.match(/([\d.]+)\s*(kg|g)\s*[*/x]\s*(\d+)/);              // 1kg*8 / 200g*18 / 1kg/8
  if (m) return { units_per_carton: Number(m[3]), unit_weight_g: toG(m[1], m[2]) };
  m = s.match(/([\d.]+)\s*(kg|g)\b/);                             // bare weight: 185g
  if (m) return { units_per_carton: null, unit_weight_g: toG(m[1], m[2]) };
  return null;
}

// ---- tokenisation ---------------------------------------------------
// Generic words carry no discriminating power — drop them. Brand and flavour
// words (milk, choco, cocoa, hazelnut, lemon, …) are kept: they decide matches.
const STOP = new Set(('with w in of on and the a for to filling fillings flavour flavours flavor flavors flav ' +
  'candy candies hard hardboiled sweets coating compound bar bars pack pcs bag bags ball boiled sour ' +
  'g kg m mix').split(' ').filter(Boolean));
// mix is generic ("summer mix"/"fruit mix") — flavour tokens still disambiguate.

function tokens(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').split(/\s+/)
    .filter((t) => {
      if (!t || STOP.has(t)) return false;
      if (/^\d+%$/.test(t)) return true;   // keep "80%" / "56%" — they discriminate
      if (/^\d+$/.test(t)) return false;    // drop bare numbers (pack handled separately)
      return true;
    });
}

// Mandatory discriminators — attributes that DEFINE the product. If a sheet row
// and a SKU each carry a value from the same group but none in common, they are
// different products and must never receive a high-confidence match, no matter
// how well the pack signature or other words line up.
const DISCRIMINATORS = [
  // colour + flavour + inclusion — one "variant" group: a product's defining
  // taste/type. milk vs dark, cocoa vs coconut, choco vs coconut all conflict.
  new Set(['milk', 'dark', 'white', 'cocoa', 'choco', 'hazelnut', 'peanut', 'peanuts', 'coconut', 'lemon',
    'cherry', 'strawberry', 'mint', 'berry', 'citrus', 'cola', 'vanilla', 'caramel', 'yogurt', 'yoghurt',
    'coffee', 'summer', 'nero', 'blanc']),
  // form / format — brownie vs jelly vs wafer are different products.
  new Set(['brownie', 'jelly', 'biscuits', 'lollipops', 'toffee', 'fudge', 'gum', 'cracker', 'crack', 'wafer', 'wafers']),
];
// Flavour tokens that, when SHARED, add a positive discriminating signal.
const FLAVORS = new Set([...DISCRIMINATORS[0], ...DISCRIMINATORS[1]]);
const hasFamily = (toks) => toks.some((t) => t === 'family');

// ---- fuzzy token equality (handles master-data typos: Frutty/Fruity, etc.) --
function editDistance(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[m][n];
}
function tokEq(a, b) {
  if (a === b) return true;
  const L = Math.max(a.length, b.length);
  if (L < 4) return false;
  const d = editDistance(a, b);
  return L >= 6 ? d <= 2 : d <= 1;
}
function sharedCount(ta, tb) {
  const used = new Set(); let n = 0;
  ta.forEach((x) => { for (let j = 0; j < tb.length; j++) { if (used.has(j)) continue; if (tokEq(x, tb[j])) { n++; used.add(j); break; } } });
  return n;
}

// Numbers a SKU description encodes (kg→grams, plus every integer: carton, g).
function skuNumbers(desc) {
  const s = String(desc == null ? '' : desc).toLowerCase();
  const set = new Set();
  (s.match(/[\d.]+\s*kg/g) || []).forEach((x) => set.add(Math.round(parseFloat(x) * 1000)));
  (s.match(/[\d.]+\s*g\b/g) || []).forEach((x) => { if (!/kg/.test(x)) set.add(Math.round(parseFloat(x))); });
  (s.match(/\d+/g) || []).forEach((x) => set.add(Number(x)));
  return set;
}

// Only the WEIGHT tokens a SKU description encodes, in grams (for the size
// discriminator — a 150 g product must never match a 1 kg SKU).
function skuWeightsG(desc) {
  const s = String(desc == null ? '' : desc).toLowerCase();
  const set = new Set();
  (s.match(/[\d.]+\s*kg/g) || []).forEach((x) => set.add(Math.round(parseFloat(x) * 1000)));
  (s.match(/[\d.]+\s*g\b/g) || []).forEach((x) => { if (!/kg/.test(x)) set.add(Math.round(parseFloat(x))); });
  return set;
}

const flavorsOf = (toks) => toks.filter((t) => FLAVORS.has(t));
const pctOf = (toks) => toks.filter((t) => /^\d+%$/.test(t));

// A discriminator group conflicts when both sides name a value from it but share none.
function discriminatorConflict(rt, st) {
  for (const group of DISCRIMINATORS) {
    const r = rt.filter((t) => group.has(t)), s = st.filter((t) => group.has(t));
    if (r.length && s.length && sharedCount(r, s) === 0) return true;
  }
  return false;
}

// Score one (sheet row, sku) candidate. A differing flavour OR cocoa-% spec
// between the row and the SKU is a hard conflict (they are different products),
// which sinks the score below any auto-match threshold.
function scorePair(row, sku) {
  const rt = tokens(row.description), st = tokens(sku.item_description);
  const shared = sharedCount(rt, st);
  const nums = skuNumbers(sku.item_description);
  const wOk = row.weight_g != null && nums.has(row.weight_g);
  const cOk = row.units_per_carton != null && nums.has(Number(row.units_per_carton));
  const pack = (wOk ? 1 : 0) + (cOk ? 1 : 0);
  const rf = flavorsOf(rt), sf = flavorsOf(st);
  const sharedFlavor = sharedCount(rf, sf);

  // Mandatory-discriminator conflicts → hard block (confidence forced to none).
  const rp = pctOf(rt), sp = pctOf(st);
  const pctConflict = rp.length > 0 && sp.length > 0 && sharedCount(rp, sp) === 0;
  const groupConflict = discriminatorConflict(rt, st);
  const familyConflict = hasFamily(rt) !== hasFamily(st);
  const skuW = skuWeightsG(sku.item_description);
  const sizeConflict = row.weight_g != null && skuW.size > 0 && !skuW.has(row.weight_g);
  const conflict = pctConflict || groupConflict || familyConflict || sizeConflict;

  let score = shared + 1.5 * pack + 1.0 * sharedFlavor;
  if (conflict) score -= 10;
  return { sku, score, shared, pack, wOk, cOk, sharedFlavor, conflict };
}

function confidenceOf(c, margin) {
  if (c.conflict || c.score <= 0) return 'none';
  if (c.pack === 2 && c.shared >= 1) return 'high';
  if (c.pack >= 1 && c.shared >= 2) return 'high';
  if (c.pack === 0 && c.shared >= 3) return 'high';
  if (c.pack === 0 && c.shared === 2 && margin >= 1) return 'high';
  if (c.pack === 2 && c.shared === 0) return 'low'; // pack coincidence only
  if (c.shared >= 1) return 'medium';
  return 'low';
}

// rows: [{ description, unit_weight, units_per_carton, shelf_life, roshen_id?, item_code? }]
// skus: SKU Master rows.
// opts.mappings: remembered manual mappings [{ description, sku_id }] — a prior
//   user decision that force-matches a sheet description to a SKU on re-import.
// Returns matched / unmatched / duplicates / ambiguous / errors.
export function matchShelfLifeRows(rows, skus, opts = {}) {
  const byRoshen = new Map(), byCode = new Map(), byId = new Map();
  (skus || []).forEach((s) => { if (s.roshen_id) byRoshen.set(normRoshen(s.roshen_id), s); if (s.item_code) byCode.set(String(s.item_code).trim().toLowerCase(), s); byId.set(s.id, s); });
  const normDesc = (d) => String(d == null ? '' : d).trim().toLowerCase().replace(/\s+/g, ' ');
  const mappingByDesc = new Map();
  (opts.mappings || []).forEach((m) => { if (m && m.description != null && m.sku_id != null) mappingByDesc.set(normDesc(m.description), m.sku_id); });

  const prepared = (rows || []).map((r, i) => ({
    i, description: r.description || '', unit_weight: r.unit_weight, units_per_carton: r.units_per_carton == null ? null : Number(r.units_per_carton),
    weight_g: parseWeightGrams(r.unit_weight), shelf: parseShelfLife(r.shelf_life), shelf_raw: r.shelf_life,
    roshen_id: r.roshen_id || null, item_code: r.item_code || null,
  }));

  const matched = [], unmatched = [], duplicates = [], ambiguous = [], errors = [];
  const usedSku = new Map();          // sku.id -> row index that claimed it
  const claimedRow = new Set();

  // 1) Deterministic matches first: sheet code (roshen/item), then a remembered
  //    manual mapping (description → SKU) from a previous import.
  prepared.forEach((row) => {
    if (row.shelf == null) { errors.push({ row, reason: 'Unparseable shelf-life value: "' + row.shelf_raw + '"' }); claimedRow.add(row.i); return; }
    let sku = null, via = null;
    if (row.roshen_id && byRoshen.has(normRoshen(row.roshen_id))) { sku = byRoshen.get(normRoshen(row.roshen_id)); via = 'roshen_id'; }
    else if (row.item_code && byCode.has(String(row.item_code).trim().toLowerCase())) { sku = byCode.get(String(row.item_code).trim().toLowerCase()); via = 'item_code'; }
    else if (mappingByDesc.has(normDesc(row.description)) && byId.has(mappingByDesc.get(normDesc(row.description)))) { sku = byId.get(mappingByDesc.get(normDesc(row.description))); via = 'remembered_mapping'; }
    if (sku) {
      if (usedSku.has(sku.id)) { duplicates.push({ row, sku, reason: 'SKU already matched by row ' + (usedSku.get(sku.id) + 1) }); claimedRow.add(row.i); return; }
      usedSku.set(sku.id, row.i); claimedRow.add(row.i);
      matched.push({ row, sku, via, confidence: via === 'remembered_mapping' ? 'mapped' : 'exact', score: 99 });
    }
  });

  // 2) Description + pack matching for the rest. Each row's candidates are
  //    scored and sorted once; assignment is an iterative greedy that always
  //    commits the globally strongest available high-confidence pair, so each
  //    SKU is claimed once and the strongest row wins a contested SKU.
  const pending = prepared.filter((r) => !claimedRow.has(r.i));
  const candsByRow = new Map();          // row.i -> sorted [{sku,score,...}]
  pending.forEach((row) => {
    const cands = (skus || []).map((sku) => scorePair(row, sku)).sort((a, b) => b.score - a.score);
    candsByRow.set(row.i, cands);
  });

  const assigned = new Map();            // row.i -> chosen candidate
  const ambiguousRows = new Map();       // row.i -> [skuA, skuB]
  while (true) {
    let pick = null; // { row, best, second, margin }
    for (const row of pending) {
      if (assigned.has(row.i) || claimedRow.has(row.i) || ambiguousRows.has(row.i)) continue;
      const cands = candsByRow.get(row.i) || [];
      const avail = cands.filter((c) => !usedSku.has(c.sku.id));
      if (!avail.length) continue;
      const best = avail[0];
      const margin = avail.length > 1 ? best.score - avail[1].score : best.score;
      if (confidenceOf(best, margin) !== 'high') continue;
      if (!pick || best.score > pick.best.score) pick = { row, best, second: avail[1] || null, margin };
    }
    if (!pick) break;
    // Genuine ambiguity: the runner-up is ALSO high-confidence and essentially
    // tied → do not guess; route to manual review (per the discriminator rule).
    if (pick.second && confidenceOf(pick.second, pick.margin) === 'high' && (pick.best.score - pick.second.score) <= 0.5) {
      ambiguousRows.set(pick.row.i, [pick.best.sku, pick.second.sku]);
      continue;
    }
    usedSku.set(pick.best.sku.id, pick.row.i);
    assigned.set(pick.row.i, pick.best);
    matched.push({ row: pick.row, sku: pick.best.sku, via: 'description+pack', confidence: 'high',
      score: +pick.best.score.toFixed(2), pack: pick.best.pack, shared: pick.best.shared });
  }

  // 3) Ambiguous rows → manual review (never auto-applied).
  ambiguousRows.forEach((skusPair, i) => {
    const row = prepared.find((r) => r.i === i);
    ambiguous.push({ row, candidates: skusPair,
      reason: 'Ambiguous — multiple equally-good SKUs: [' + skusPair[0].item_code + '] ' + skusPair[0].item_description +
        ' / [' + skusPair[1].item_code + '] ' + skusPair[1].item_description });
    claimedRow.add(i);
  });

  // 4) Whatever is still unclaimed → unmatched. Name a nearest SKU only when it
  //    shares the product's brand token, otherwise stay generic (no guessing).
  const brandTokenOf = (row) => (tokens(row.description)[0] || '');
  prepared.forEach((row) => {
    if (claimedRow.has(row.i) || assigned.has(row.i)) return;
    const cands = candsByRow.get(row.i) || [];
    const brand = brandTokenOf(row);
    const brandNear = cands.find((c) => c.score > 0 && tokens(c.sku.item_description).some((t) => tokEq(t, brand)));
    unmatched.push({
      row, best: brandNear ? { sku: brandNear.sku, score: +brandNear.score.toFixed(2) } : null,
      reason: brandNear
        ? 'No confident match — nearest is [' + brandNear.sku.item_code + '] ' + brandNear.sku.item_description + ' (different pack/variant). Map manually.'
        : 'No matching SKU found in SKU Master. Map manually.',
    });
  });

  return { matched, unmatched, duplicates, ambiguous, errors, total: prepared.length };
}
