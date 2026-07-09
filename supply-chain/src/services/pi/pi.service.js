// Proforma-Invoice service — persistence + workflow transitions.
import { getClient, one } from '../supabase/client.js';

const sb = () => getClient();

export async function listPis() {
  const { data, error } = await sb().from('proforma_invoices')
    .select('*, supply_orders(order_number)').order('imported_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function getPiWithItems(piId) {
  const { data, error } = await sb().from('proforma_invoices')
    .select('*, proforma_invoice_items(*)').eq('id', piId).single();
  if (error) throw error;
  return data;
}

// Persist a freshly imported+compared PI and advance the order to "PI Imported".
export async function saveImportedPi({ orderId, parsed, compare }) {
  const s = compare.summary;
  const status = s.ok ? 'Imported' : 'Validation Required';
  const insert = {
    order_id: orderId,
    pi_number: parsed.header.pi_number,
    pi_date: parsed.header.pi_date,
    supplier: parsed.header.supplier,
    customer: parsed.header.customer,
    currency: parsed.header.currency || 'SAR',
    payment_terms: parsed.header.payment_terms,
    delivery_terms: parsed.header.delivery_terms,
    vat_number: parsed.header.vat_number,
    cr_number: parsed.header.cr_number,
    total_quantity: s.piCases,
    total_taxable: parsed.totals.total_taxable,
    total_vat: parsed.totals.total_vat,
    grand_total: parsed.totals.grand_total,
    gross_weight: parsed.totals.gross_weight,
    status,
    validation_summary: s,
    header_extra: {},
    source_filename: parsed.source_filename || null,
  };
  const { data: pi, error } = await sb().from('proforma_invoices').insert(insert).select().single();
  if (error) throw error;

  const items = compare.rows.filter((r) => r.pi).map((r) => {
    const p = r.pi;
    const matchedCode = r.order ? r.order.item_code : null;
    return {
      pi_id: pi.id, line_no: p.line_no, pi_item_code: p.pi_item_code, roshen_id: p.roshen_id,
      item_code: matchedCode, description: p.description, uom: p.uom, quantity: p.quantity,
      box_pcs: p.box_pcs, unit_price: p.unit_price, case_price: p.case_price,
      discount_percent: p.discount_percent, net_price: p.net_price, taxable_amount: p.taxable_amount,
      vat_percent: p.vat_percent, vat_amount: p.vat_amount, line_total: p.line_total,
      match_status: r.kind, matched_order_item_code: matchedCode,
    };
  });
  if (items.length) {
    const it = await sb().from('proforma_invoice_items').insert(items);
    if (it.error) throw it.error;
  }
  const up = await sb().from('supply_orders').update({ status: 'PI Imported' }).eq('id', orderId);
  if (up.error) throw up.error;
  return pi;
}

export async function approvePi(piId, orderId) {
  const a = await sb().from('proforma_invoices')
    .update({ status: 'Approved', approved_at: new Date().toISOString() }).eq('id', piId);
  if (a.error) throw a.error;
  await sb().from('supply_orders').update({ status: 'PI Approved' }).eq('id', orderId);
}

export async function rejectPi(piId, orderId) {
  const a = await sb().from('proforma_invoices').update({ status: 'Rejected' }).eq('id', piId);
  if (a.error) throw a.error;
  await sb().from('supply_orders').update({ status: 'Approved' }).eq('id', orderId);
}

export async function returnToRevision(piId, orderId) {
  await sb().from('proforma_invoices').update({ status: 'Rejected' }).eq('id', piId);
  const a = await sb().from('supply_orders').update({ status: 'Draft' }).eq('id', orderId);
  if (a.error) throw a.error;
}

export { one };
