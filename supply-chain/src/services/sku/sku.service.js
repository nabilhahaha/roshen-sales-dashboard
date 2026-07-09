// SKU Master service — the Roshen SKU catalogue and the single source of truth
// for shelf life, unit weight, units/carton, minimum receiving % and status.
// Fully maintainable: create / edit / activate / deactivate, every change
// audited. Shelf-Life imports only ever UPDATE existing SKUs (never create).
import { getClient } from '../supabase/client.js';

const FIELDS = 'id,roshen_id,item_code,item_description,price_case,status,' +
  'shelf_life_value,shelf_life_unit,min_remaining_shelf_life_pct,unit_weight_g,units_per_carton,created_at,updated_at';

// Editable SKU columns (what create/update accept). Everything else is derived.
const EDITABLE = ['roshen_id', 'item_code', 'item_description', 'price_case', 'status',
  'shelf_life_value', 'shelf_life_unit', 'min_remaining_shelf_life_pct', 'unit_weight_g', 'units_per_carton'];
const NUMERIC = new Set(['price_case', 'shelf_life_value', 'min_remaining_shelf_life_pct', 'unit_weight_g', 'units_per_carton']);

function clean(patch) {
  const out = {};
  EDITABLE.forEach((k) => {
    if (patch[k] === undefined) return;
    let v = patch[k];
    if (v === '' || v == null) v = null;
    else if (NUMERIC.has(k)) v = Number(v);
    out[k] = v;
  });
  return out;
}

export async function listSkus({ activeOnly = true } = {}) {
  let q = getClient().from('sku_master').select(FIELDS).order('item_description');
  if (activeOnly) q = q.eq('status', 'active');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function getSku(id) {
  const { data, error } = await getClient().from('sku_master').select(FIELDS).eq('id', id).single();
  if (error) throw error;
  return data;
}

// ---- audit ----------------------------------------------------------
export async function logSkuAudit(skuId, action, { detail, actor } = {}) {
  const { error } = await getClient().from('sku_audit_log').insert({ sku_id: skuId, action, detail: detail || null, actor: actor || null });
  if (error) throw error;
}
export async function listSkuAudit(skuId) {
  const { data, error } = await getClient().from('sku_audit_log').select('*').eq('sku_id', skuId).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// ---- create / update / status --------------------------------------
export async function createSku(input, actor) {
  const row = clean(input);
  if (!row.item_code) throw new Error('Item Code is required.');
  if (!row.item_description) throw new Error('Item Description is required.');
  if (row.status == null) row.status = 'active';
  const { data, error } = await getClient().from('sku_master').insert(row).select(FIELDS).single();
  if (error) {
    if (error.code === '23505') throw new Error('A SKU with this Item Code already exists.');
    throw error;
  }
  try { await logSkuAudit(data.id, 'created', { detail: { after: data }, actor }); } catch (e) { /* best-effort */ }
  return data;
}

// Update editable fields. Records a before/after audit entry. Company-specific
// fields are only changed when the caller explicitly includes them.
export async function updateSku(id, patch, actor) {
  const before = await getSku(id);
  const row = clean(patch);
  if (!Object.keys(row).length) return before;
  row.updated_at = new Date().toISOString();
  const { data, error } = await getClient().from('sku_master').update(row).eq('id', id).select(FIELDS).single();
  if (error) {
    if (error.code === '23505') throw new Error('A SKU with this Item Code already exists.');
    throw error;
  }
  const changed = {};
  Object.keys(row).forEach((k) => { if (k !== 'updated_at' && String(before[k]) !== String(data[k])) changed[k] = { from: before[k], to: data[k] }; });
  try { await logSkuAudit(id, 'updated', { detail: { changed }, actor }); } catch (e) { /* best-effort */ }
  return data;
}

export async function setSkuStatus(id, status, actor) {
  const s = status === 'active' ? 'active' : 'inactive';
  const { data, error } = await getClient().from('sku_master')
    .update({ status: s, updated_at: new Date().toISOString() }).eq('id', id).select(FIELDS).single();
  if (error) throw error;
  try { await logSkuAudit(id, s === 'active' ? 'activated' : 'deactivated', { actor }); } catch (e) { /* best-effort */ }
  return data;
}

export async function countSkus() {
  const { count, error } = await getClient()
    .from('sku_master').select('id', { count: 'exact', head: true }).eq('status', 'active');
  if (error) throw error;
  return count || 0;
}

// Back-compat: shelf-life-only edit (value + unit + min %). Audited.
export async function updateShelfLife(id, { shelf_life_value, shelf_life_unit, min_remaining_shelf_life_pct }, actor) {
  return updateSku(id, { shelf_life_value, shelf_life_unit, min_remaining_shelf_life_pct }, actor);
}

// ---- remembered import mappings ------------------------------------
const normDesc = (d) => String(d == null ? '' : d).trim().toLowerCase().replace(/\s+/g, ' ');

export async function listShelfLifeMappings() {
  const { data, error } = await getClient().from('shelf_life_import_mappings').select('*');
  if (error) throw error;
  return (data || []).map((m) => ({ description: m.source_description, sku_id: m.sku_id }));
}

export async function saveShelfLifeMapping({ description, sku_id, createdBy } = {}) {
  const { error } = await getClient().from('shelf_life_import_mappings')
    .upsert({ source_description: description, norm_description: normDesc(description), sku_id, created_by: createdBy || null }, { onConflict: 'norm_description' });
  if (error) throw error;
}

// index helpers used by the order editor
export function indexByCode(skus) {
  const m = {};
  skus.forEach((s) => { m[s.item_code] = s; });
  return m;
}
export function indexByRoshen(skus) {
  const m = {};
  skus.forEach((s) => { if (s.roshen_id) m[String(s.roshen_id).trim()] = s; });
  return m;
}
