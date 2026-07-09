// SKU Master service — the Roshen SKU catalogue and the single source of truth
// for shelf life, unit weight, units/carton, minimum receiving % and status.
// Fully maintainable: create / edit / activate / deactivate, every change
// audited. Shelf-Life imports only ever UPDATE existing SKUs (never create).
import { getClient } from '../supabase/client.js';

const FIELDS = 'id,roshen_id,item_code,item_description,price_case,status,' +
  'shelf_life_value,shelf_life_unit,min_remaining_shelf_life_pct,unit_weight_g,units_per_carton,' +
  'barcode,brand,category,sub_category,product_family,variant_flavor,version,created_at,updated_at';

// Editable SKU columns (what create/update accept). Everything else is derived.
const EDITABLE = ['roshen_id', 'item_code', 'item_description', 'price_case', 'status',
  'shelf_life_value', 'shelf_life_unit', 'min_remaining_shelf_life_pct', 'unit_weight_g', 'units_per_carton',
  'barcode', 'brand', 'category', 'sub_category', 'product_family', 'variant_flavor'];
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
const normR = (r) => { const s = String(r == null ? '' : r).trim(); return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s; };
const normD = (d) => String(d == null ? '' : d).trim().toLowerCase().replace(/\s+/g, ' ');

// Duplicate-SKU guards (beyond the DB's hard-unique Item Code):
//  * Roshen ID must be unique unless explicitly allowed (opts.allowDuplicateRoshen)
//  * an identical product signature (same description + weight + units/carton)
//    is blocked unless opts.allowDuplicate — never silently create a twin SKU.
async function assertNotDuplicate(row, opts = {}, excludeId = null) {
  const { data: all, error } = await getClient().from('sku_master').select('id,roshen_id,item_code,item_description,unit_weight_g,units_per_carton');
  if (error) throw error;
  const others = (all || []).filter((s) => s.id !== excludeId);
  if (row.roshen_id && !opts.allowDuplicateRoshen) {
    const hit = others.find((s) => s.roshen_id && normR(s.roshen_id) === normR(row.roshen_id));
    if (hit) throw new Error(`Roshen ID ${row.roshen_id} is already used by [${hit.item_code}] ${hit.item_description}. Allow duplicate Roshen IDs explicitly if this is intended.`);
  }
  if (!opts.allowDuplicate && row.item_description != null && row.unit_weight_g != null && row.units_per_carton != null) {
    const hit = others.find((s) => normD(s.item_description) === normD(row.item_description) &&
      Number(s.unit_weight_g) === Number(row.unit_weight_g) && Number(s.units_per_carton) === Number(row.units_per_carton));
    if (hit) throw new Error(`A SKU with the same description and pack (${row.unit_weight_g} g × ${row.units_per_carton}) already exists: [${hit.item_code}].`);
  }
}

export async function createSku(input, actor, opts = {}) {
  const row = clean(input);
  if (!row.item_code) throw new Error('Item Code is required.');
  if (!row.item_description) throw new Error('Item Description is required.');
  if (row.status == null) row.status = 'active';
  await assertNotDuplicate(row, opts);
  const { data, error } = await getClient().from('sku_master').insert(row).select(FIELDS).single();
  if (error) {
    if (error.code === '23505') throw new Error('A SKU with this Item Code already exists.');
    throw error;
  }
  try { await logSkuAudit(data.id, 'created', { detail: { after: data }, actor }); } catch (e) { /* best-effort */ }
  return data;
}

// Update editable fields. Records a before/after audit entry (the DB trigger
// also snapshots the prior row into sku_versions and bumps the version).
// Company-specific fields are only changed when the caller includes them.
export async function updateSku(id, patch, actor, opts = {}) {
  const before = await getSku(id);
  const row = clean(patch);
  if (!Object.keys(row).length) return before;
  if (row.roshen_id !== undefined && String(row.roshen_id || '') !== String(before.roshen_id || '')) {
    await assertNotDuplicate({ ...before, ...row }, opts, id);
  }
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

// ---- satellites: barcodes / suppliers / attachments / versions ------
// Multiple barcodes, multiple suppliers (with supplier-specific item codes),
// images / spec PDFs, and the immutable version history written by the DB
// trigger on every SKU change.
export async function getSkuDetail(skuId) {
  const c = getClient();
  const [b, s, a, v] = await Promise.all([
    c.from('sku_barcodes').select('*').eq('sku_id', skuId).order('is_primary', { ascending: false }),
    c.from('sku_suppliers').select('*').eq('sku_id', skuId).order('is_default', { ascending: false }),
    c.from('sku_attachments').select('id,kind,filename,mime,byte_size,created_at').eq('sku_id', skuId).order('created_at'),
    c.from('sku_versions').select('id,version,created_at').eq('sku_id', skuId).order('version', { ascending: false }),
  ]);
  for (const r of [b, s, a, v]) if (r.error) throw r.error;
  return { barcodes: b.data || [], suppliers: s.data || [], attachments: a.data || [], versions: v.data || [] };
}

export async function addSkuBarcode(skuId, { barcode, kind, is_primary } = {}, actor) {
  if (!barcode) throw new Error('Barcode is required.');
  const { error } = await getClient().from('sku_barcodes').insert({ sku_id: skuId, barcode: String(barcode).trim(), kind: kind || 'EAN13', is_primary: !!is_primary });
  if (error) { if (error.code === '23505') throw new Error('This barcode is already registered on a SKU.'); throw error; }
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { barcode_added: { to: barcode } } }, actor }); } catch (e) { /* best-effort */ }
}
export async function removeSkuBarcode(id, skuId, actor) {
  const { error } = await getClient().from('sku_barcodes').delete().eq('id', id);
  if (error) throw error;
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { barcode_removed: { id } } }, actor }); } catch (e) { /* best-effort */ }
}

export async function addSkuSupplier(skuId, { supplier, supplier_item_code, is_default, lead_time_days, notes } = {}, actor) {
  if (!supplier) throw new Error('Supplier name is required.');
  const { error } = await getClient().from('sku_suppliers').insert({
    sku_id: skuId, supplier: String(supplier).trim(), supplier_item_code: supplier_item_code || null,
    is_default: !!is_default, lead_time_days: lead_time_days == null || lead_time_days === '' ? null : Number(lead_time_days), notes: notes || null,
  });
  if (error) { if (error.code === '23505') throw new Error('This supplier is already linked to the SKU.'); throw error; }
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { supplier_added: { to: supplier } } }, actor }); } catch (e) { /* best-effort */ }
}
export async function removeSkuSupplier(id, skuId, actor) {
  const { error } = await getClient().from('sku_suppliers').delete().eq('id', id);
  if (error) throw error;
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { supplier_removed: { id } } }, actor }); } catch (e) { /* best-effort */ }
}

export async function addSkuAttachment(skuId, { kind, filename, mime, size, base64 } = {}, actor) {
  const { error } = await getClient().from('sku_attachments').insert({
    sku_id: skuId, kind: kind || 'image', filename: filename || null, mime: mime || null,
    byte_size: size || null, data: base64 || null, created_by: actor || null,
  });
  if (error) throw error;
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { attachment_added: { to: filename } } }, actor }); } catch (e) { /* best-effort */ }
}
export async function getSkuAttachment(id) {
  const { data, error } = await getClient().from('sku_attachments').select('filename,mime,data').eq('id', id).single();
  if (error) throw error;
  return data;
}
export async function removeSkuAttachment(id, skuId, actor) {
  const { error } = await getClient().from('sku_attachments').delete().eq('id', id);
  if (error) throw error;
  try { await logSkuAudit(skuId, 'updated', { detail: { changed: { attachment_removed: { id } } }, actor }); } catch (e) { /* best-effort */ }
}

export async function getSkuVersion(skuId, version) {
  const { data, error } = await getClient().from('sku_versions').select('*').eq('sku_id', skuId).eq('version', version).single();
  if (error) throw error;
  return data;
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
