// Purchase Order revision service.
//
// The original PO (supply_orders + supply_order_items) is Revision 0 and is
// never modified. Each applied revision is a full line snapshot plus an audit
// trail. Downstream modules read the LATEST revision via getEffectiveLines().
import { getClient } from '../supabase/client.js';
import { resolveOpenDisputes } from './dispute.service.js';

const sb = () => getClient();

const toComparable = (rows, qtyKey, priceKey, descKey) =>
  rows.map((r) => ({
    item_code: r.item_code,
    roshen_id: r.roshen_id ? String(r.roshen_id).trim() : null,
    description: r[descKey],
    cases: Number(r[qtyKey]),
    case_price: Number(r[priceKey]),
    line_total: Number(r[qtyKey]) * Number(r[priceKey]),
  }));

// Items of a specific revision number for an order.
export async function getRevisionItems(orderId, revisionNo) {
  const rev = await sb().from('supply_order_revisions')
    .select('id, supply_order_revision_items(*)')
    .eq('order_id', orderId).eq('revision_no', revisionNo).single();
  if (rev.error) throw rev.error;
  return rev.data.supply_order_revision_items || [];
}

// The current effective PO lines (comparable shape): latest revision if any,
// otherwise the original Revision-0 items. `order` must include current_revision
// and supply_order_items.
export async function getEffectiveLines(order) {
  if (order.current_revision && order.current_revision > 0) {
    const items = await getRevisionItems(order.id, order.current_revision);
    return toComparable(items, 'ordered_cases', 'price_case', 'item_description');
  }
  return toComparable(order.supply_order_items || [], 'ordered_cases', 'price_case', 'item_description');
}

// ---- pure: turn compare rows + user resolutions into new lines + audit ----
// rows: comparePiToOrder result rows (order = effective PO line, pi = PI line)
// resolutions: { [key]: { action, reason } }
//   key = order.item_code for existing lines, 'PI:'+code for additional items.
const lineFromOrder = (o) => ({ item_code: o.item_code, roshen_id: o.roshen_id, item_description: o.description, ordered_cases: o.cases, price_case: o.case_price });
const base = (o, type, extra) => Object.assign({ change_type: type, item_code: o.item_code, roshen_id: o.roshen_id, description: o.description }, extra || {});

export function additionalKey(piRow, skuByRoshen) {
  const sku = skuByRoshen[piRow.roshen_id];
  return 'PI:' + (sku ? sku.item_code : (piRow.pi_item_code || piRow.roshen_id));
}

export function computeRevision(rows, resolutions, skuByRoshen, acceptedBy) {
  const lines = [];
  const changes = [];
  const res = (k, d) => resolutions[k] || d;
  rows.forEach((r) => {
    if (r.kind === 'matched' || r.kind === 'amount_diff') { lines.push(lineFromOrder(r.order)); return; }
    if (r.kind === 'missing') {
      const c = res(r.order.item_code, { action: 'remove' });
      if (c.action === 'remove') changes.push(base(r.order, 'removed_item', { old_qty: r.order.cases, old_price: r.order.case_price, reason: c.reason, accepted_by: acceptedBy }));
      else { lines.push(lineFromOrder(r.order)); changes.push(base(r.order, 'kept_item', { old_qty: r.order.cases, new_qty: r.order.cases, reason: c.reason || 'Kept in PO', accepted_by: acceptedBy })); }
      return;
    }
    if (r.kind === 'qty_diff') {
      const c = res(r.order.item_code, { action: 'accept' });
      const l = lineFromOrder(r.order);
      if (c.action === 'accept') { l.ordered_cases = r.pi.box_pcs; changes.push(base(r.order, 'quantity_change', { old_qty: r.order.cases, new_qty: r.pi.box_pcs, reason: c.reason, accepted_by: acceptedBy })); }
      else changes.push(base(r.order, 'kept_item', { old_qty: r.order.cases, new_qty: r.order.cases, reason: c.reason || 'Kept original quantity', accepted_by: acceptedBy }));
      lines.push(l); return;
    }
    if (r.kind === 'price_diff') {
      const c = res(r.order.item_code, { action: 'accept' });
      const l = lineFromOrder(r.order);
      if (c.action === 'accept') { l.price_case = r.pi.case_price; changes.push(base(r.order, 'price_change', { old_price: r.order.case_price, new_price: r.pi.case_price, reason: c.reason, accepted_by: acceptedBy })); }
      else changes.push(base(r.order, 'kept_item', { old_price: r.order.case_price, new_price: r.order.case_price, reason: c.reason || 'Kept original price', accepted_by: acceptedBy }));
      lines.push(l); return;
    }
    if (r.kind === 'additional') {
      const sku = skuByRoshen[r.pi.roshen_id];
      const key = additionalKey(r.pi, skuByRoshen);
      const c = res(key, { action: 'ignore' });
      if (c.action === 'add' && sku) {
        lines.push({ item_code: sku.item_code, roshen_id: sku.roshen_id, item_description: sku.item_description, ordered_cases: r.pi.box_pcs, price_case: r.pi.case_price });
        changes.push({ change_type: 'added_item', item_code: sku.item_code, roshen_id: sku.roshen_id, description: sku.item_description, new_qty: r.pi.box_pcs, new_price: r.pi.case_price, reason: c.reason, accepted_by: acceptedBy });
      }
      return;
    }
  });
  return { lines, changes };
}

// Persist a new revision (does NOT touch the original PO items). Advances the
// order to "Revision Applied" and bumps current_revision.
export async function applyRevision(orderId, lines, changes, piId, createdBy) {
  if (!lines.length) throw new Error('A revision must contain at least one line.');
  const ord = await sb().from('supply_orders').select('current_revision').eq('id', orderId).single();
  if (ord.error) throw ord.error;
  const revisionNo = (ord.data.current_revision || 0) + 1;

  const rev = await sb().from('supply_order_revisions')
    .insert({ order_id: orderId, revision_no: revisionNo, pi_id: piId || null, created_by: createdBy || null })
    .select().single();
  if (rev.error) throw rev.error;

  const items = lines.map((l) => ({ revision_id: rev.data.id, item_code: l.item_code, roshen_id: l.roshen_id, item_description: l.item_description, ordered_cases: Number(l.ordered_cases), price_case: Number(l.price_case) }));
  const it = await sb().from('supply_order_revision_items').insert(items);
  if (it.error) throw it.error;

  if (changes.length) {
    const ch = await sb().from('supply_order_revision_changes')
      .insert(changes.map((c) => Object.assign({ revision_id: rev.data.id, accepted_by: createdBy || null }, c)));
    if (ch.error) throw ch.error;
  }

  const up = await sb().from('supply_orders').update({ current_revision: revisionNo, status: 'Revision Applied' }).eq('id', orderId);
  if (up.error) throw up.error;

  // A revision supersedes any open disputes for this order.
  try { await resolveOpenDisputes(orderId, { resolvedBy: createdBy, resolution: 'Revised' }); } catch (e) { /* non-fatal */ }
  return { revisionId: rev.data.id, revisionNo };
}

// All applied revisions (1..n) with their items + audit changes, newest first.
export async function listRevisions(orderId) {
  const { data, error } = await sb().from('supply_order_revisions')
    .select('*, supply_order_revision_items(*), supply_order_revision_changes(*)')
    .eq('order_id', orderId).order('revision_no', { ascending: false });
  if (error) throw error;
  return data || [];
}
