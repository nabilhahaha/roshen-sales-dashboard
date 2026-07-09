// Shelf-Life Master Import — persistence. Applies ONLY the Shelf Life Value +
// Unit from the matched sheet rows onto SKU Master. Every other field
// (minimum remaining shelf-life %, price, status, and any company-specific
// setting) is left exactly as it was — SKU Master stays the single source of
// truth and the import is non-destructive.
import { getClient } from '../supabase/client.js';
import { logSkuAudit } from './sku.service.js';

const sameShelf = (sku, value, unit) =>
  String(sku.shelf_life_value == null ? '' : sku.shelf_life_value) === String(value) &&
  (sku.shelf_life_unit || '') === unit;

// matches: [{ row:{shelf:{value,unit}, description}, sku }] from matchShelfLifeRows().
export async function applyShelfLifeMatches(matches, { actor } = {}) {
  const c = getClient();
  let updated = 0, unchanged = 0;
  const applied = [];
  for (const m of matches || []) {
    if (!m.sku || !m.row || !m.row.shelf) continue;
    const { value, unit } = m.row.shelf;
    if (sameShelf(m.sku, value, unit)) { unchanged++; continue; }
    const { error } = await c.from('sku_master')
      .update({ shelf_life_value: value, shelf_life_unit: unit, updated_at: new Date().toISOString() })
      .eq('id', m.sku.id);            // updates value + unit ONLY — never min % / price / status
    if (error) throw error;
    updated++;
    const rec = { id: m.sku.id, item_code: m.sku.item_code, roshen_id: m.sku.roshen_id,
      description: m.sku.item_description,
      from: { value: m.sku.shelf_life_value, unit: m.sku.shelf_life_unit }, to: { value, unit } };
    applied.push(rec);
    try { await logSkuAudit(m.sku.id, 'shelf_import', { detail: { from: rec.from, to: rec.to, source: m.row.description, via: m.via }, actor }); } catch (e) { /* best-effort */ }
  }
  return { updated, unchanged, applied };
}
