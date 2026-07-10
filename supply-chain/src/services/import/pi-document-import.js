// PI document import — maps a parsed supplier PI document (pi-parser output)
// onto the PI master record (supply_orders + supply_order_items), exactly as
// the document reads. Pure: no DOM, no network.
//
// Quantities: delivery tracking uses cases, so ordered_cases = the document's
// "Box, Pcs" column (falling back to "Number of Units" when a document has no
// box column). Prices/amounts are stored from the document — never from the
// SKU Master.

const normCode = (v) => String(v == null ? '' : v).trim().toLowerCase();
const normRoshen = (v) => String(v == null ? '' : v).trim().replace(/^0+(?=\d)/, '');

// Is this parsed workbook a recognizable supplier PI document (vs a plain
// item list that should go through manual column mapping)?
export function looksLikePiDocument(doc) {
  return !!(doc && doc.items && doc.items.length &&
    (doc.header.pi_number || doc.header.pi_date || doc.header.document_type));
}

export function documentToOrderPlan(doc, skus, filename) {
  const byCode = {}, byRoshen = {};
  (skus || []).forEach((s) => {
    byCode[normCode(s.item_code)] = s;
    if (s.roshen_id) byRoshen[normRoshen(s.roshen_id)] = s;
  });

  const h = doc.header || {}, t = doc.totals || {};
  const header = {
    order_number: h.pi_number || null,           // the document number IS the PI number
    order_date: h.pi_date || null,
    supplier: h.supplier || 'Roshen',
    document_type: h.document_type || null,
    supplier_vat: h.vat_number || null,
    supplier_cr: h.cr_number || null,
    supplier_address: h.supplier_address || null,
    supplier_short_address: h.supplier_short_address || null,
    supplier_bank: h.supplier_bank || null,
    supplier_iban: h.supplier_iban || null,
    customer_name: h.customer || null,
    customer_vat: h.customer_vat || null,
    customer_cr: h.customer_cr || null,
    salesman: h.salesman || null,
    currency: h.currency || 'SAR',
    payment_terms: h.payment_terms || null,
    delivery_terms: h.delivery_terms || null,
    total_units: t.total_quantity ?? null,
    total_net: t.total_taxable ?? null,
    total_vat: t.total_vat ?? null,
    total_gross: t.grand_total ?? null,
    gross_weight_kg: t.gross_weight ?? null,
    source_filename: filename || null,
    notes: 'Imported from ' + (filename || 'Excel'),
  };

  const lines = [], unknown = [], badQty = [];
  (doc.items || []).forEach((it) => {
    const sku = (it.pi_item_code && byCode[normCode(it.pi_item_code)]) ||
                (it.roshen_id && byRoshen[normRoshen(it.roshen_id)]) || null;
    const cases = it.box_pcs ?? it.quantity;
    const row = {
      line_no: it.line_no || null,
      supplier_item_code: it.pi_item_code || null,   // document "Item Code" verbatim
      item_code: sku ? sku.item_code : (it.pi_item_code || null),
      roshen_id: it.roshen_id || (sku ? sku.roshen_id : null),
      item_description: it.description || (sku ? sku.item_description : null),
      uom: it.uom || null,
      units_qty: it.quantity ?? null,
      ordered_cases: cases,
      unit_price: it.unit_price ?? null,
      discount_percent: it.discount_percent ?? null,
      net_unit_price: it.net_price ?? null,
      taxable_amount: it.taxable_amount ?? null,
      vat_percent: it.vat_percent ?? null,
      vat_amount: it.vat_amount ?? null,
      amount: it.line_total ?? null,
      // net price per case from the document itself (taxable / boxes)
      price_case: it.case_price ?? (it.taxable_amount != null && cases ? +(it.taxable_amount / cases).toFixed(4) : null),
      _match: sku ? (byCode[normCode(it.pi_item_code)] ? 'code' : 'roshen') : 'none',
    };
    if (!sku) { unknown.push(row); return; }
    if (!(Number(cases) > 0)) { badQty.push(row); return; }
    lines.push(row);
  });

  // Cross-check the document's own totals against the sum of its lines.
  const sum = (k) => lines.concat(unknown).reduce((a, l) => a + (Number(l[k]) || 0), 0);
  const close = (a, b) => a == null || b == null || Math.abs(Number(a) - Number(b)) <= 0.05;
  const checks = {
    net: { computed: +sum('taxable_amount').toFixed(2), document: header.total_net, ok: close(sum('taxable_amount'), header.total_net) },
    vat: { computed: +sum('vat_amount').toFixed(2), document: header.total_vat, ok: close(sum('vat_amount'), header.total_vat) },
    gross: { computed: +sum('amount').toFixed(2), document: header.total_gross, ok: close(sum('amount'), header.total_gross) },
  };

  return { header, lines, unknown, badQty, checks };
}

// Strip preview-only keys before inserting order items.
export function planLinesForDb(lines) {
  return lines.map(({ _match, ...l }) => l);
}
