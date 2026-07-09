// Shelf-Life Master Import — change plan + persistence.
//
// The import is non-destructive by default: extracted values (Shelf Life, Unit
// Weight, Units/Carton) are saved only where the SKU field is EMPTY. The user
// can explicitly choose "Overwrite existing data", which lets sheet values
// replace differing stored values. Minimum Remaining Shelf Life % is a one-time
// default (70) applied only when empty — never overwritten in any mode.
//
// planShelfLifeChanges() produces the exact per-field change list (current →
// new, source, action) that the preview shows and applyShelfLifeMatches()
// executes — one code path, so the preview cannot diverge from the apply.
import { getClient } from '../supabase/client.js';
import { logSkuAudit } from './sku.service.js';
import { parsePackFromDescription } from './shelf-life-import.js';

export const DEFAULT_MIN_PCT = 70;

const sameShelf = (sku, value, unit) =>
  String(sku.shelf_life_value == null ? '' : sku.shelf_life_value) === String(value) &&
  (sku.shelf_life_unit || '') === unit;

const fmtShelf = (v, u) => (v != null && u ? `${v} ${u}` : null);
const fmtG = (g) => (g == null ? null : (g >= 1000 ? (g / 1000) + ' kg' : g + ' g'));

// One field's plan entry. `apply` is the single truth for whether it is written.
function entry(field, label, current, next, source, { empty, differs, overwrite }) {
  let action, apply = false;
  if (!differs) action = 'Skip (unchanged)';
  else if (empty) { action = 'Update (fill empty)'; apply = true; }
  else if (overwrite) { action = 'Update (overwrite)'; apply = true; }
  else action = 'Skip (has value)';
  return { field, label, current, next, source, action, apply };
}

// matches: [{ row, sku, via }] from matchShelfLifeRows(). Returns per-SKU plans:
// [{ sku, row, via, fields:[{field,label,current,next,source,action,apply}] }]
export function planShelfLifeChanges(matches, { overwrite = false } = {}) {
  const plans = [];
  for (const m of matches || []) {
    if (!m.sku || !m.row || !m.row.shelf) continue;
    const fields = [];
    const desc = parsePackFromDescription(m.sku.item_description) || {};

    // Shelf Life (source: always the sheet)
    fields.push(entry('shelf', 'Shelf Life',
      fmtShelf(m.sku.shelf_life_value, m.sku.shelf_life_unit),
      fmtShelf(m.row.shelf.value, m.row.shelf.unit), 'Sheet', {
        empty: m.sku.shelf_life_value == null || !m.sku.shelf_life_unit,
        differs: !sameShelf(m.sku, m.row.shelf.value, m.row.shelf.unit),
        overwrite,
      }));

    // Unit Weight (sheet column first, description parser as fallback)
    const w = m.row.weight_g != null ? { v: m.row.weight_g, src: 'Sheet' }
      : (desc.unit_weight_g != null ? { v: desc.unit_weight_g, src: 'Description Parser' } : null);
    if (w) fields.push(entry('unit_weight_g', 'Unit Weight', fmtG(m.sku.unit_weight_g), fmtG(w.v), w.src, {
      empty: m.sku.unit_weight_g == null, differs: Number(m.sku.unit_weight_g) !== Number(w.v), overwrite,
    }));

    // Units / Carton
    const c = m.row.units_per_carton != null ? { v: Number(m.row.units_per_carton), src: 'Sheet' }
      : (desc.units_per_carton != null ? { v: desc.units_per_carton, src: 'Description Parser' } : null);
    if (c) fields.push(entry('units_per_carton', 'Units / Carton',
      m.sku.units_per_carton == null ? null : String(m.sku.units_per_carton), String(c.v), c.src, {
        empty: m.sku.units_per_carton == null, differs: Number(m.sku.units_per_carton) !== c.v, overwrite,
      }));

    // Min Remaining % — one-time default, fill-empty only, in EVERY mode.
    if (m.sku.min_remaining_shelf_life_pct == null) {
      fields.push({ field: 'min_pct', label: 'Min Remaining %', current: null, next: DEFAULT_MIN_PCT + '%', source: 'Default (70%)', action: 'Update (fill empty)', apply: true });
    }

    // raw values the apply step needs
    plans.push({ sku: m.sku, row: m.row, via: m.via, fields,
      raw: { shelf: m.row.shelf, weight: w ? w.v : null, carton: c ? c.v : null } });
  }
  return plans;
}

// Execute a plan (or build one from matches + overwrite). Only `apply`-flagged
// fields are written; every write is recorded in the SKU audit history.
export async function applyShelfLifeMatches(matches, { actor, overwrite = false, plans } = {}) {
  const c = getClient();
  const plan = plans || planShelfLifeChanges(matches, { overwrite });
  let updated = 0, unchanged = 0, defaulted = 0, packFilled = 0, overwritten = 0;
  const applied = [], packReview = [];
  for (const p of plan) {
    const todo = p.fields.filter((f) => f.apply);
    const missesPack = (p.sku.unit_weight_g == null && p.raw.weight == null) || (p.sku.units_per_carton == null && p.raw.carton == null);
    if (missesPack) packReview.push({ id: p.sku.id, item_code: p.sku.item_code, description: p.sku.item_description });
    if (!todo.length) { unchanged++; continue; }

    const patch = { updated_at: new Date().toISOString() };
    const auditDetail = { source: p.row.description, via: p.via, mode: overwrite ? 'overwrite' : 'fill-empty', changed: {} };
    todo.forEach((f) => {
      if (f.field === 'shelf') { patch.shelf_life_value = p.raw.shelf.value; patch.shelf_life_unit = p.raw.shelf.unit; }
      else if (f.field === 'unit_weight_g') patch.unit_weight_g = p.raw.weight;
      else if (f.field === 'units_per_carton') patch.units_per_carton = p.raw.carton;
      else if (f.field === 'min_pct') patch.min_remaining_shelf_life_pct = DEFAULT_MIN_PCT;
      auditDetail.changed[f.field] = { from: f.current, to: f.next, source: f.source };
      if (f.action === 'Update (overwrite)') overwritten++;
    });
    const { error } = await c.from('sku_master').update(patch).eq('id', p.sku.id);
    if (error) throw error;

    if (todo.some((f) => f.field === 'shelf')) updated++; else unchanged++;
    if (todo.some((f) => f.field === 'min_pct')) defaulted++;
    if (todo.some((f) => f.field === 'unit_weight_g' || f.field === 'units_per_carton')) packFilled++;
    applied.push({ id: p.sku.id, item_code: p.sku.item_code, roshen_id: p.sku.roshen_id,
      description: p.sku.item_description, changes: todo.map((f) => ({ field: f.field, from: f.current, to: f.next, source: f.source })) });
    try { await logSkuAudit(p.sku.id, 'shelf_import', { detail: auditDetail, actor }); } catch (e) { /* audit best-effort */ }
  }
  return { updated, unchanged, defaulted, packFilled, overwritten, packReview, applied };
}
