// Purchase Order AMENDMENTS — ERP-style change management.
//
// The original Purchase Order is NEVER edited directly. Every change is an
// amendment document with its own lifecycle:
//
//   Draft → Submitted → Approved → Applied
//                     ↘ Rejected            (any pre-Applied stage can be
//   Draft/Submitted → Cancelled              cancelled by its owner)
//
// Only a Super Admin can Approve or Apply (models/permissions.js — the gate
// is enforced HERE, not just hidden in the UI). Applying writes the new
// quantities / prices / ETAs to supply_order_items and refreshes the order
// totals — after that every screen (Open Orders, Business File, Summary,
// Dashboard, exports, KPIs, Remaining, Progress %, Business Status) shows the
// new figures automatically because they ALL read the same single sources
// (po_line_fulfillment + supply_order_items). Amendment rows, line snapshots
// and the audit trail are permanent — the DB forbids deleting them.
import { getClient } from '../supabase/client.js';
import { lineKey } from '../../utils/format.js';
import { dnShipsQuantity } from '../../models/business-status.js';
import { currentActor, canApproveAmendments } from '../../models/permissions.js';

const c = () => getClient();

// ---- client fingerprint for the immutable audit trail -----------------------
let ipCache = null;
async function clientIp() {
  if (ipCache) return ipCache;
  try {
    const r = await Promise.race([
      fetch('https://api.ipify.org?format=json').then((x) => x.json()),
      new Promise((_, rej) => setTimeout(rej, 2500)),
    ]);
    ipCache = r.ip || 'unknown';
  } catch (e) { ipCache = 'unavailable'; }
  return ipCache;
}
const browserInfo = () => {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : 'Other';
  const device = /Mobile|iPhone|Android/.test(ua) ? 'Mobile' : /iPad|Tablet/.test(ua) ? 'Tablet' : 'Desktop';
  return { browser: `${browser} · ${ua.slice(0, 120)}`, device };
};

async function audit(amendmentId, orderId, action, { oldValue = null, newValue = null, reason = null, actor = null } = {}) {
  const { browser, device } = browserInfo();
  await c().from('po_amendment_audit').insert({
    amendment_id: amendmentId, order_id: orderId, action,
    actor: actor || currentActor(), ip: await clientIp(), browser, device,
    old_value: oldValue, new_value: newValue, reason,
  });
}

// ---- reads -------------------------------------------------------------------
export async function listAmendments(orderId) {
  const { data, error } = await c().from('po_amendments')
    .select('*').eq('order_id', orderId).order('amendment_no', { ascending: true });
  if (error) throw error;
  return data || [];
}

export async function getAmendment(id) {
  const [{ data: amd, error }, { data: lines }] = await Promise.all([
    c().from('po_amendments').select('*').eq('id', id).single(),
    c().from('po_amendment_lines').select('*').eq('amendment_id', id).order('id'),
  ]);
  if (error) throw error;
  return { ...amd, lines: lines || [] };
}

export async function amendmentAudit(amendmentId) {
  const { data, error } = await c().from('po_amendment_audit')
    .select('*').eq('amendment_id', amendmentId).order('at');
  if (error) throw error;
  return data || [];
}

// current order lines + everything needed to validate an amendment:
// per-line shipped (delivery-note documents, the ONE dnShipsQuantity rule),
// received (released receipts), and whether ANY document/movement touches it
export async function amendmentContext(orderId) {
  const [{ data: items }, { data: ful }, { data: dns }, { data: sii }, { data: moves }, { data: skus }] = await Promise.all([
    c().from('supply_order_items').select('*').eq('order_id', orderId).order('line_no'),
    c().from('po_line_fulfillment').select('roshen_id,item_code,received_cases').eq('order_id', orderId),
    c().from('delivery_notes')
      .select('id,status, delivery_note_items(item_code,roshen_id, delivery_note_batches(cases))')
      .eq('order_id', orderId).not('status', 'in', '("Cancelled","Reversed")'),
    c().from('supplier_invoice_items').select('roshen_id,item_code, supplier_invoices!inner(order_id,status)')
      .eq('supplier_invoices.order_id', orderId).neq('supplier_invoices.status', 'Cancelled'),
    c().from('inventory_movements').select('roshen_id,item_code').eq('order_id', orderId),
    c().from('sku_master').select('id,item_code,item_description'),
  ]);
  const shipped = {}, hasDn = {}, hasInv = {}, hasMove = {}, received = {};
  (dns || []).forEach((d) => (d.delivery_note_items || []).forEach((it) => {
    const k = lineKey(it.roshen_id, it.item_code);
    hasDn[k] = true;
    if (dnShipsQuantity(d.status)) shipped[k] = (shipped[k] || 0) + (it.delivery_note_batches || []).reduce((a, b) => a + Number(b.cases || 0), 0);
  }));
  (ful || []).forEach((r) => { received[lineKey(r.roshen_id, r.item_code)] = Number(r.received_cases || 0); });
  (sii || []).forEach((r) => { hasInv[lineKey(r.roshen_id, r.item_code)] = true; });
  (moves || []).forEach((r) => { hasMove[lineKey(r.roshen_id, r.item_code)] = true; });
  const skuByCode = {}; (skus || []).forEach((k2) => { skuByCode[k2.item_code] = k2; });
  return { items: items || [], shipped, received, hasDn, hasInv, hasMove, skuByCode };
}

// ---- validation — shown in the editor BEFORE Apply is possible ---------------
// lines: [{ op:'change'|'add'|'remove', po_item_id, item_code, roshen_id,
//           description, new_qty, new_price, new_eta, ... }]
export function validateAmendment(lines, ctx) {
  const errors = [];
  const byId = {}; ctx.items.forEach((it) => { byId[it.id] = it; });
  lines.forEach((l) => {
    const item = l.po_item_id ? byId[l.po_item_id] : null;
    const k = item ? lineKey(item.roshen_id, item.item_code) : lineKey(l.roshen_id, l.item_code);
    const label = (item && item.item_code) || l.item_code || l.roshen_id || '?';
    const shipped = ctx.shipped[k] || 0, received = ctx.received[k] || 0;
    if (l.op === 'change') {
      const q = Number(l.new_qty);
      if (!(q > 0)) errors.push({ line: label, error: `Quantity must be greater than zero` });
      else if (q < shipped) errors.push({ line: label, error: `Ordered quantity ${q} cannot be lower than the shipped quantity ${shipped}` });
      else if (q < received) errors.push({ line: label, error: `Ordered quantity ${q} cannot be lower than the received quantity ${received}` });
      if (l.new_price != null && !(Number(l.new_price) > 0)) errors.push({ line: label, error: 'Price must be greater than zero' });
    }
    if (l.op === 'remove') {
      if (ctx.hasDn[k]) errors.push({ line: label, error: 'Cannot remove — a Delivery Note exists for this SKU' });
      if (received > 0) errors.push({ line: label, error: 'Cannot remove — a Goods Receipt exists for this SKU' });
      if (ctx.hasInv[k]) errors.push({ line: label, error: 'Cannot remove — a Supplier Invoice exists for this SKU' });
      if (ctx.hasMove[k]) errors.push({ line: label, error: 'Cannot remove — inventory movements exist for this SKU' });
    }
    if (l.op === 'add') {
      if (!l.item_code && !l.roshen_id) errors.push({ line: '(new)', error: 'A new line needs an SKU code' });
      if (l.item_code && ctx.skuByCode && !ctx.skuByCode[l.item_code]) errors.push({ line: label, error: 'Unknown SKU — the item code must exist in SKU Master' });
      if (!(Number(l.new_qty) > 0)) errors.push({ line: label, error: 'New line quantity must be greater than zero' });
      if (!(Number(l.new_price) > 0)) errors.push({ line: label, error: 'New line price must be greater than zero' });
      const dup = ctx.items.some((it) => lineKey(it.roshen_id, it.item_code) === k);
      if (dup) errors.push({ line: label, error: 'This SKU is already on the order — change its line instead' });
    }
  });
  return errors;
}

// ---- lifecycle ----------------------------------------------------------------
export async function createAmendment(orderId, { reason, referenceEmail, referenceNumber, comments, lines }) {
  if (!reason) throw new Error('A reason is required');
  const changed = (lines || []).filter((l) => l.op);
  if (!changed.length) throw new Error('The amendment changes nothing');
  const existing = await listAmendments(orderId);
  const open = existing.find((a) => ['Draft', 'Submitted', 'Approved'].includes(a.status));
  if (open) throw new Error(`Amendment #${open.amendment_no} is still ${open.status} — finish it first`);
  const no = existing.length ? Math.max(...existing.map((a) => a.amendment_no)) + 1 : 1;
  const { data: amd, error } = await c().from('po_amendments').insert({
    order_id: orderId, amendment_no: no, status: 'Draft', reason,
    reference_email: referenceEmail || null, reference_number: referenceNumber || null,
    comments: comments || null, created_by: currentActor(),
  }).select().single();
  if (error) throw error;
  const rows = changed.map((l) => ({
    amendment_id: amd.id, po_item_id: l.po_item_id || null, op: l.op,
    item_code: l.item_code || null, roshen_id: l.roshen_id || null,
    supplier_item_code: l.supplier_item_code || null, description: l.description || null,
    sku_id: l.sku_id || null,
    old_qty: l.old_qty ?? null, new_qty: l.new_qty ?? null,
    old_price: l.old_price ?? null, new_price: l.new_price ?? null,
    old_eta: l.old_eta || null, new_eta: l.new_eta || null,
  }));
  const { error: e2 } = await c().from('po_amendment_lines').insert(rows);
  if (e2) throw e2;
  await audit(amd.id, orderId, 'created', { newValue: { reason, lines: rows.length }, reason });
  return amd;
}

const transition = async (id, from, patch, action, reason) => {
  const { data: amd, error } = await c().from('po_amendments').select('*').eq('id', id).single();
  if (error) throw error;
  if (!from.includes(amd.status)) throw new Error(`Amendment is ${amd.status} — cannot ${action}`);
  const { error: e2 } = await c().from('po_amendments').update(patch).eq('id', id).eq('status', amd.status);
  if (e2) throw e2;
  await audit(id, amd.order_id, action, { oldValue: { status: amd.status }, newValue: { status: patch.status }, reason });
  return { ...amd, ...patch };
};

export const submitAmendment = (id) =>
  transition(id, ['Draft'], { status: 'Submitted', submitted_at: new Date().toISOString(), submitted_by: currentActor() }, 'submitted');

export async function approveAmendment(id) {
  if (!canApproveAmendments()) throw new Error('Only a Super Admin can approve amendments');
  return transition(id, ['Submitted'], { status: 'Approved', approved_at: new Date().toISOString(), approved_by: currentActor() }, 'approved');
}
export const rejectAmendment = (id, reason) => {
  if (!canApproveAmendments()) throw new Error('Only a Super Admin can reject amendments');
  if (!reason) throw new Error('A rejection reason is required');
  return transition(id, ['Submitted', 'Approved'], { status: 'Rejected', rejected_at: new Date().toISOString(), rejected_by: currentActor(), rejection_reason: reason }, 'rejected', reason);
};
export const cancelAmendment = (id) =>
  transition(id, ['Draft', 'Submitted'], { status: 'Cancelled', cancelled_at: new Date().toISOString(), cancelled_by: currentActor() }, 'cancelled');

// Apply — Super Admin only. Re-validates against LIVE data, then writes the
// new values through the normal item rows. Every screen recomputes from the
// same single sources, so nothing needs a manual refresh anywhere.
export async function applyAmendment(id) {
  if (!canApproveAmendments()) throw new Error('Only a Super Admin can apply amendments');
  const amd = await getAmendment(id);
  if (amd.status !== 'Approved') throw new Error(`Amendment is ${amd.status} — approve it first`);
  const ctx = await amendmentContext(amd.order_id);
  const errors = validateAmendment(amd.lines, ctx);
  if (errors.length) throw new Error('Validation failed: ' + errors.map((e) => `${e.line}: ${e.error}`).join(' · '));

  const byId = {}; ctx.items.forEach((it) => { byId[it.id] = it; });
  for (const l of amd.lines) {
    if (l.op === 'change') {
      const item = byId[l.po_item_id];
      if (!item) throw new Error('Order line disappeared — reload and retry');
      const qty = l.new_qty != null ? Number(l.new_qty) : Number(item.ordered_cases);
      const price = l.new_price != null ? Number(l.new_price) : Number(item.price_case);
      const lineTotal = +(qty * price).toFixed(2);
      const vatPct = Number(item.vat_percent || 0);
      const vat = +(lineTotal * vatPct / 100).toFixed(2);
      // line_total is a generated column (ordered_cases * price_case)
      const patch = {
        ordered_cases: qty, price_case: price,
        taxable_amount: lineTotal, vat_amount: vat, amount: +(lineTotal + vat).toFixed(2),
      };
      if (l.new_eta) patch.expected_arrival = l.new_eta;
      const { error } = await c().from('supply_order_items').update(patch).eq('id', item.id);
      if (error) throw error;
      await audit(id, amd.order_id, 'line_applied', {
        oldValue: { item: item.item_code, qty: item.ordered_cases, price: item.price_case, eta: item.expected_arrival },
        newValue: { item: item.item_code, qty, price, eta: l.new_eta || item.expected_arrival },
      });
    } else if (l.op === 'add') {
      const master = ctx.skuByCode[l.item_code] || {};
      const qty = Number(l.new_qty), price = Number(l.new_price);
      const lineTotal = +(qty * price).toFixed(2);
      const vatPct = 15;
      const maxLine = Math.max(0, ...ctx.items.map((it) => Number(it.line_no || 0)));
      const { error } = await c().from('supply_order_items').insert({
        order_id: amd.order_id, item_code: l.item_code, roshen_id: l.roshen_id,
        supplier_item_code: l.supplier_item_code || null,
        item_description: l.description || master.item_description || '', sku_id: l.sku_id || master.id || null,
        ordered_cases: qty, price_case: price,
        taxable_amount: lineTotal, vat_percent: vatPct,
        vat_amount: +(lineTotal * vatPct / 100).toFixed(2),
        amount: +(lineTotal * (1 + vatPct / 100)).toFixed(2),
        line_no: maxLine + 1, expected_arrival: l.new_eta || null,
      });
      if (error) throw error;
      await audit(id, amd.order_id, 'line_applied', { newValue: { added: l.item_code || l.roshen_id, qty, price } });
    } else if (l.op === 'remove') {
      const item = byId[l.po_item_id];
      if (!item) continue; // already gone
      const { error } = await c().from('supply_order_items').delete().eq('id', item.id);
      if (error) throw error;
      await audit(id, amd.order_id, 'line_applied', { oldValue: { removed: item.item_code, qty: item.ordered_cases, price: item.price_case } });
    }
  }

  // refresh the order header totals from the (now current) lines
  const { data: after } = await c().from('supply_order_items')
    .select('taxable_amount,vat_amount,amount,units_qty').eq('order_id', amd.order_id);
  const tot = (after || []).reduce((a, r) => ({
    net: a.net + Number(r.taxable_amount || 0), vat: a.vat + Number(r.vat_amount || 0),
    gross: a.gross + Number(r.amount || 0), units: a.units + Number(r.units_qty || 0),
  }), { net: 0, vat: 0, gross: 0, units: 0 });
  await c().from('supply_orders').update({
    total_net: +tot.net.toFixed(2), total_vat: +tot.vat.toFixed(2), total_gross: +tot.gross.toFixed(2),
  }).eq('id', amd.order_id);

  const applied = await transition(id, ['Approved'], { status: 'Applied', applied_at: new Date().toISOString(), applied_by: currentActor() }, 'applied');
  return applied;
}
