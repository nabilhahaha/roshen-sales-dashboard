// Purchase Order service — CRUD + lifecycle, wrapping the Supabase tables.
// Query shapes here are the ones verified end-to-end against the live project.
import { getClient } from '../supabase/client.js';

const sb = () => getClient();
const FULL = '*, supply_order_items(*), proforma_invoices(id,pi_number,pi_date,status,imported_at)';

export async function listOrders() {
  const { data, error } = await sb().from('supply_orders')
    .select('*, supply_order_items(ordered_cases,price_case), proforma_invoices(id,pi_number,pi_date,status,imported_at)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getOrder(id) {
  const { data, error } = await sb().from('supply_orders').select(FULL).eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function ordersByStatus(statuses) {
  const { data, error } = await sb().from('supply_orders')
    .select('id,order_number,order_date,supplier,status, supply_order_items(ordered_cases,price_case), proforma_invoices(id,pi_number,status)')
    .in('status', statuses).order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function createOrder(header, createdBy = null) {
  const { data, error } = await sb().from('supply_orders')
    .insert({ ...header, status: 'Draft', created_by: createdBy }).select().single();
  if (error) throw error;
  return data;
}

export async function updateHeader(id, header) {
  const { error } = await sb().from('supply_orders').update(header).eq('id', id);
  if (error) throw error;
}

export async function replaceItems(orderId, lines) {
  const del = await sb().from('supply_order_items').delete().eq('order_id', orderId);
  if (del.error) throw del.error;
  if (lines.length) {
    const ins = await sb().from('supply_order_items')
      .insert(lines.map((l) => ({ order_id: orderId, ...l })));
    if (ins.error) throw ins.error;
  }
}

export async function approve(id) {
  const { error } = await sb().from('supply_orders')
    .update({ status: 'Approved', approved_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function setStatus(id, status) {
  const { error } = await sb().from('supply_orders').update({ status }).eq('id', id);
  if (error) throw error;
}

// ---- manual close (business action — never a delete) ----------------------
// Closes an order that the supplier cannot / will not complete. Mandatory
// reason, optional comments and replacement-PO link; remaining quantities
// become Cancelled (derived — historical data untouched); audited.
export async function closeOrderManually(id, { reason, comments, closedBy, replacedByOrderId } = {}) {
  if (!reason || !String(reason).trim()) throw new Error('A close reason is required');
  const order = await getOrder(id);
  if (['Closed', 'Financially Closed'].includes(order.status)) throw new Error('This purchase order is already closed.');
  const closed_at = new Date().toISOString();
  const { error } = await sb().from('supply_orders').update({
    status: 'Closed',
    close_reason: String(reason).trim(),
    close_comments: comments ? String(comments).trim() : null,
    closed_by: closedBy || null,
    closed_at,
    replaced_by_order_id: replacedByOrderId || null,
    updated_at: closed_at,
  }).eq('id', id);
  if (error) throw error;
  await auditOrder(id, 'closed', closedBy, {
    reason, comments: comments || null, previous_status: order.status,
    replaced_by_order_id: replacedByOrderId || null,
  });
  return { id, status: 'Closed', closed_at };
}

// PO audit log (approve / close / status change …)
export async function auditOrder(orderId, action, actor, details) {
  const { error } = await sb().from('po_audit_log')
    .insert({ order_id: orderId, action, actor: actor || null, details: details || null });
  if (error) throw error;
}

export async function listOrderAudit(orderId) {
  const { data, error } = await sb().from('po_audit_log')
    .select('*').eq('order_id', orderId).order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// orders that can be picked as a replacement for a closed PO
export async function listReplacementCandidates(excludeId) {
  const { data, error } = await sb().from('supply_orders')
    .select('id,order_number,status,order_date')
    .not('status', 'in', '("Closed","Financially Closed")')
    .neq('id', excludeId)
    .order('created_at', { ascending: false }).limit(50);
  if (error) throw error;
  return data || [];
}

// Map an order's items to the shape the PI comparison engine expects.
export function comparableLines(order) {
  return (order.supply_order_items || []).map((it) => ({
    item_code: it.item_code,
    roshen_id: it.roshen_id ? String(it.roshen_id).trim() : null,
    description: it.item_description,
    cases: Number(it.ordered_cases),
    case_price: Number(it.price_case),
    line_total: Number(it.ordered_cases) * Number(it.price_case),
  }));
}

// derived totals for a set of order items
export function totals(items = []) {
  const cases = items.reduce((a, b) => a + Number(b.ordered_cases || 0), 0);
  const value = items.reduce((a, b) => a + Number(b.ordered_cases || 0) * Number(b.price_case || 0), 0);
  return { count: items.length, cases, value };
}
