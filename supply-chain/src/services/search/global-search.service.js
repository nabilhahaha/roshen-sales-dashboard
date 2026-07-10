// Global Smart Search — one query across every procurement module. Partial /
// exact case-insensitive matching on document numbers, SKUs, Roshen codes,
// descriptions, suppliers, batch numbers, warehouses, statuses, file names
// and created-by/approved-by users. Results are grouped by document type and
// each one carries its navigation target. Read-only.
import { getClient } from '../supabase/client.js';

const LIM = 6;
const esc = (q) => String(q).replace(/[%_]/g, (m) => '\\' + m);

export async function globalSearch(qRaw) {
  const q = String(qRaw || '').trim();
  if (q.length < 2) return { query: q, groups: [] };
  const c = getClient();
  const like = '%' + esc(q) + '%';
  const or = (fields) => fields.map((f) => `${f}.ilike.${like}`).join(',');

  const [pos, dns, sis, grs, skus, batches, files, pis] = await Promise.all([
    c.from('supply_orders')
      .select('id,order_number,supplier,status,order_date,close_reason,closed_by,created_by,warehouse')
      .or(or(['order_number', 'supplier', 'status', 'warehouse', 'created_by', 'closed_by'])).limit(LIM),
    c.from('delivery_notes')
      .select('id,dn_number,supplier,status,dn_date,po_reference,customer,created_by,received_by')
      .or(or(['dn_number', 'supplier', 'status', 'po_reference', 'customer', 'created_by', 'received_by'])).limit(LIM),
    c.from('supplier_invoices')
      .select('id,invoice_number,supplier,status,invoice_date,dn_reference,created_by')
      .or(or(['invoice_number', 'supplier', 'status', 'dn_reference', 'created_by'])).limit(LIM),
    c.from('goods_receipts')
      .select('id,grn_number,warehouse,status,receipt_date,order_id')
      .or(or(['grn_number', 'warehouse', 'status'])).limit(LIM),
    c.from('sku_master')
      .select('id,item_code,roshen_id,item_description')
      .or(or(['item_code', 'roshen_id', 'item_description'])).limit(LIM),
    c.from('batch_master')
      .select('id,batch_no,roshen_id,item_code,warehouse,gr_id,order_id,expiry_date')
      .or(or(['batch_no', 'roshen_id', 'item_code', 'warehouse'])).limit(LIM),
    c.from('document_attachments')
      .select('id,filename,doc_type,doc_id,uploaded_by,created_at')
      .eq('superseded', false)
      .or(or(['filename', 'uploaded_by'])).limit(LIM),
    c.from('proforma_invoices')
      .select('id,pi_number,status,order_id')
      .or(or(['pi_number', 'status'])).limit(LIM),
  ]);

  const exactFirst = (rows, key) => (rows || []).slice().sort((a, b) => {
    const ax = String(a[key] || '').toLowerCase() === q.toLowerCase() ? 0 : 1;
    const bx = String(b[key] || '').toLowerCase() === q.toLowerCase() ? 0 : 1;
    return ax - bx;
  });

  const groups = [];
  const add = (label, icon, items) => { if (items.length) groups.push({ label, icon, items }); };

  add('Purchase Orders', '📄', exactFirst(pos.data, 'order_number').map((o) => ({
    title: o.order_number, sub: [o.supplier, o.order_date, o.close_reason || o.status].filter(Boolean).join(' · '),
    nav: ['purchase-orders', { orderId: o.id, mode: 'view' }],
  })));
  add('Delivery Notes', '🚚', exactFirst(dns.data, 'dn_number').map((d) => ({
    title: d.dn_number, sub: [d.supplier, d.dn_date, d.status].filter(Boolean).join(' · '),
    nav: ['delivery-notes', { view: 'detail', dnId: d.id }],
  })));
  add('Supplier Invoices', '🧾', exactFirst(sis.data, 'invoice_number').map((s) => ({
    title: s.invoice_number, sub: [s.supplier, s.invoice_date, s.status].filter(Boolean).join(' · '),
    nav: ['supplier-invoices', { view: 'detail', invoiceId: s.id }],
  })));
  add('Warehouse Receipts', '📦', exactFirst(grs.data, 'grn_number').map((g) => ({
    title: g.grn_number || ('#' + g.id), sub: [g.warehouse, g.receipt_date, g.status].filter(Boolean).join(' · '),
    nav: ['goods-receiving', { view: 'detail', grId: g.id }],
  })));
  add('SKUs', '🍬', exactFirst(skus.data, 'roshen_id').map((s) => ({
    title: `${s.roshen_id || s.item_code}`, sub: (s.item_description || '').slice(0, 60),
    nav: ['sku-master', { q: s.roshen_id || s.item_code }],
  })));
  add('Batches', '🔖', exactFirst(batches.data, 'batch_no').map((b) => ({
    title: b.batch_no || ('batch #' + b.id), sub: [b.roshen_id || b.item_code, b.warehouse, b.expiry_date && ('exp ' + b.expiry_date)].filter(Boolean).join(' · '),
    nav: b.gr_id ? ['goods-receiving', { view: 'detail', grId: b.gr_id }] : ['purchase-orders', { orderId: b.order_id, mode: 'view' }],
  })));
  add('Proforma Invoices', '🧾', exactFirst(pis.data, 'pi_number').map((x) => ({
    title: x.pi_number, sub: x.status || '',
    nav: ['purchase-orders', { orderId: x.order_id, mode: 'view' }],
  })));
  add('Attached Files', '📎', (files.data || []).map((f) => ({
    title: f.filename, sub: `${f.doc_type.replace('_', ' ')} · ${f.uploaded_by || ''} · ${String(f.created_at || '').slice(0, 10)}`,
    nav: f.doc_type === 'purchase_order' ? ['purchase-orders', { orderId: f.doc_id, mode: 'view' }]
      : f.doc_type === 'delivery_note' ? ['delivery-notes', { view: 'detail', dnId: f.doc_id }]
      : ['supplier-invoices', { view: 'detail', invoiceId: f.doc_id }],
  })));

  return { query: q, groups };
}
