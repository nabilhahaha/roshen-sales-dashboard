// PO↔PI dispute service (Option 3 — "Dispute").
//
// Records PI differences as OPEN disputes and lets the order proceed on the
// ORIGINAL PO baseline. It never creates a revision and never changes the PO
// lines, so delivery / receiving / inventory / matching (which all read the
// PO / latest revision) automatically ignore the disputed PI-only lines. A
// dispute stays Open until a revision is applied (auto-resolved) or the user
// closes it manually.
import { getClient } from '../supabase/client.js';
import { normRoshen } from '../../utils/format.js';

// rows: comparePiToOrder result rows; skuByRoshen: index for additional lines.
export async function disputeDifferences({ orderId, piId, rows, skuByRoshen = {}, createdBy }) {
  const c = getClient();
  const diffs = (rows || []).filter((r) => r.kind !== 'matched' && r.kind !== 'amount_diff');
  const recs = diffs.map((r) => {
    const o = r.order, p = r.pi;
    const sku = p ? skuByRoshen[normRoshen(p.roshen_id)] : null;
    return {
      order_id: orderId, pi_id: piId || null, kind: r.kind,
      item_code: (o && o.item_code) || (sku && sku.item_code) || (p && p.pi_item_code) || null,
      roshen_id: (o && o.roshen_id) || (p && p.roshen_id) || null,
      description: (o && o.description) || (sku && sku.item_description) || (p && p.description) || null,
      po_qty: o ? o.cases : null, po_price: o ? o.case_price : null,
      pi_qty: p ? p.box_pcs : null, pi_price: p ? p.case_price : null,
      qty_delta: +(((p ? p.box_pcs : 0) - (o ? o.cases : 0)) || 0).toFixed(2),
      value_delta: +(((p ? p.taxable_amount : 0) - (o ? o.line_total : 0)) || 0).toFixed(2),
      status: 'Open', created_by: createdBy || null,
    };
  });

  // Replace any prior open disputes for this order (re-disputing supersedes).
  await c.from('po_pi_disputes').delete().eq('order_id', orderId).eq('status', 'Open');
  if (recs.length) { const { error } = await c.from('po_pi_disputes').insert(recs); if (error) throw error; }

  // Operations proceed on the PO baseline: advance the order so downstream
  // modules (which read the original PO) can run. The PO lines are untouched.
  const { error: e2 } = await c.from('supply_orders')
    .update({ status: 'PI Approved', updated_at: new Date().toISOString() }).eq('id', orderId);
  if (e2) throw e2;
  return { disputes: recs.length };
}

export async function listDisputes(orderId, { openOnly = false } = {}) {
  let q = getClient().from('po_pi_disputes').select('*').order('created_at', { ascending: false });
  if (orderId) q = q.eq('order_id', orderId);
  if (openOnly) q = q.eq('status', 'Open');
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function countOpenDisputes(orderId) {
  const { count, error } = await getClient().from('po_pi_disputes')
    .select('id', { count: 'exact', head: true }).eq('order_id', orderId).eq('status', 'Open');
  if (error) throw error;
  return count || 0;
}

export async function closeDispute(id, { resolvedBy, resolution = 'Closed' } = {}) {
  const { error } = await getClient().from('po_pi_disputes')
    .update({ status: 'Resolved', resolution, resolved_by: resolvedBy || null, resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// Auto-resolve open disputes when a revision supersedes them.
export async function resolveOpenDisputes(orderId, { resolvedBy, resolution = 'Revised' } = {}) {
  const { error } = await getClient().from('po_pi_disputes')
    .update({ status: 'Resolved', resolution, resolved_by: resolvedBy || null, resolved_at: new Date().toISOString() })
    .eq('order_id', orderId).eq('status', 'Open');
  if (error) throw error;
}
