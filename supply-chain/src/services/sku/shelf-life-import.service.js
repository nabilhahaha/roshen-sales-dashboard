// Shelf-Life Master Import — persistence. Applies ONLY the Shelf Life Value +
// Unit from the matched sheet rows onto SKU Master, plus a one-time default
// initialisation of the Minimum Remaining Shelf Life %: any imported SKU whose
// min % is NULL gets DEFAULT_MIN_PCT; an existing value (75, 80, …) is never
// overwritten. Every other field (price, status, weight, notes and any other
// company-specific setting) is left exactly as it was — SKU Master stays the
// single source of truth and the import is non-destructive.
import { getClient } from '../supabase/client.js';
import { logSkuAudit } from './sku.service.js';
import { parsePackFromDescription } from './shelf-life-import.js';

export const DEFAULT_MIN_PCT = 70;

const sameShelf = (sku, value, unit) =>
  String(sku.shelf_life_value == null ? '' : sku.shelf_life_value) === String(value) &&
  (sku.shelf_life_unit || '') === unit;

// Best-available pack signature for a matched SKU: the sheet's own columns are
// authoritative; the SKU description ("12X350G", "1kg*8bags") is the fallback.
function packFor(row, sku) {
  const fromDesc = parsePackFromDescription(sku.item_description) || {};
  return {
    unit_weight_g: row.weight_g != null ? row.weight_g : (fromDesc.unit_weight_g != null ? fromDesc.unit_weight_g : null),
    units_per_carton: row.units_per_carton != null ? Number(row.units_per_carton) : (fromDesc.units_per_carton != null ? fromDesc.units_per_carton : null),
  };
}

// matches: [{ row:{shelf:{value,unit}, description}, sku }] from matchShelfLifeRows().
export async function applyShelfLifeMatches(matches, { actor } = {}) {
  const c = getClient();
  let updated = 0, unchanged = 0, defaulted = 0, packFilled = 0;
  const applied = [], packReview = [];
  for (const m of matches || []) {
    if (!m.sku || !m.row || !m.row.shelf) continue;
    const { value, unit } = m.row.shelf;
    const needsShelf = !sameShelf(m.sku, value, unit);
    const needsMinDefault = m.sku.min_remaining_shelf_life_pct == null;

    // Fill (never overwrite) missing pack fields from the sheet / description.
    const pack = packFor(m.row, m.sku);
    const fillW = m.sku.unit_weight_g == null && pack.unit_weight_g != null;
    const fillC = m.sku.units_per_carton == null && pack.units_per_carton != null;
    if ((m.sku.unit_weight_g == null && pack.unit_weight_g == null) || (m.sku.units_per_carton == null && pack.units_per_carton == null)) {
      packReview.push({ id: m.sku.id, item_code: m.sku.item_code, description: m.sku.item_description });
    }

    if (!needsShelf && !needsMinDefault && !fillW && !fillC) { unchanged++; continue; }

    const patch = { updated_at: new Date().toISOString() };
    if (needsShelf) { patch.shelf_life_value = value; patch.shelf_life_unit = unit; }
    if (needsMinDefault) patch.min_remaining_shelf_life_pct = DEFAULT_MIN_PCT; // one-time default; never overwrites a set value
    if (fillW) patch.unit_weight_g = pack.unit_weight_g;
    if (fillC) patch.units_per_carton = pack.units_per_carton;
    const { error } = await c.from('sku_master').update(patch).eq('id', m.sku.id);
    if (error) throw error;

    if (needsShelf) updated++; else unchanged++;
    if (needsMinDefault) defaulted++;
    if (fillW || fillC) packFilled++;
    const rec = { id: m.sku.id, item_code: m.sku.item_code, roshen_id: m.sku.roshen_id,
      description: m.sku.item_description,
      from: { value: m.sku.shelf_life_value, unit: m.sku.shelf_life_unit }, to: { value, unit },
      min_defaulted: needsMinDefault, pack_filled: fillW || fillC };
    applied.push(rec);
    try {
      await logSkuAudit(m.sku.id, 'shelf_import', { detail: {
        ...(needsShelf ? { from: rec.from, to: rec.to } : {}),
        ...(needsMinDefault ? { min_pct_defaulted: DEFAULT_MIN_PCT } : {}),
        ...(fillW ? { unit_weight_g: pack.unit_weight_g } : {}),
        ...(fillC ? { units_per_carton: pack.units_per_carton } : {}),
        source: m.row.description, via: m.via }, actor });
    } catch (e) { /* audit best-effort */ }
  }
  return { updated, unchanged, defaulted, packFilled, packReview, applied };
}
