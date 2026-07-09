// Workflow service — the document pipeline across orders and their PIs.
import { getClient, one } from '../supabase/client.js';
import { ORDER_STAGES } from '../../models/order-status.js';

export { ORDER_STAGES };

export async function listWorkflow() {
  const { data, error } = await getClient().from('supply_orders')
    .select('id,order_number,order_date,status, proforma_invoices(pi_number,pi_date,status,imported_at)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map((o) => ({ ...o, pi: one(o.proforma_invoices) }));
}

export function stageCounts(orders) {
  const counts = {};
  ORDER_STAGES.forEach((s) => (counts[s] = 0));
  orders.forEach((o) => { if (counts[o.status] != null) counts[o.status]++; });
  return counts;
}
