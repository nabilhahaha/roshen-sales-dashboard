// Line-level supplier-invoice reconciliation (pure).
//
// Reconciles a supplier invoice against the PO ↔ Delivery Note baseline, line
// by line, keyed only by Roshen ID / Item Code (never description). For each
// SKU it compares what the invoice bills against what is legitimately billable
// — the delivered quantity at the PO price, net of what earlier invoices on the
// same PO already billed (so partial invoicing reconciles correctly).
//
// Per-line classification (primary kind + flags):
//   matched        invoiced qty ≤ open balance, price and tax within tolerance
//   qty_variance   invoiced more cases than remain billable (over-invoiced)
//   price_variance invoiced case price ≠ PO case price
//   tax_variance   invoiced VAT ≠ expected 15%
//   missing        a delivered line this invoice does not bill (still open)
//   extra          an invoice line for a SKU not on the delivery note
//
// A line under-billing the open balance is a legitimate PARTIAL, not a variance.
import { lineKey as keyOf, approxEq } from '../../utils/format.js';

const n = (v) => Number(v || 0);
const round = (v) => +Number(v || 0).toFixed(2);
const VAT_RATE = 0.15;

// expected: [{ roshen_id, item_code, description, delivered_cases, already_invoiced_cases, po_price }]
// invoiceLines: [{ roshen_id, item_code, description, invoiced_cases, case_price, taxable_amount, vat_amount, vat_percent }]
// opts: { qtyTol, priceTol, taxTol }
export function matchInvoiceLines(expected, invoiceLines, opts = {}) {
  const qtyTol = opts.qtyTol != null ? opts.qtyTol : 0.01;
  const priceTol = opts.priceTol != null ? opts.priceTol : 0.01;

  const expByKey = new Map();
  (expected || []).forEach((e) => {
    const k = keyOf(e.roshen_id, e.item_code);
    if (!k) return;
    const delivered = n(e.delivered_cases);
    const already = n(e.already_invoiced_cases);
    expByKey.set(k, {
      key: k, roshen_id: e.roshen_id, item_code: e.item_code, description: e.description,
      delivered, already_invoiced: already,
      open_to_invoice: round(Math.max(0, delivered - already)),
      po_price: n(e.po_price),
    });
  });

  const seen = new Set();
  const lines = [];

  (invoiceLines || []).forEach((il) => {
    const k = keyOf(il.roshen_id, il.item_code);
    const exp = k ? expByKey.get(k) : null;
    const invoicedCases = n(il.invoiced_cases);
    const casePrice = il.case_price != null ? n(il.case_price) : null;
    const taxable = il.taxable_amount != null ? n(il.taxable_amount) : (casePrice != null ? round(casePrice * invoicedCases) : null);
    const vatAmount = il.vat_amount != null ? n(il.vat_amount) : null;
    const expectedVat = taxable != null ? round(taxable * VAT_RATE) : null;

    if (!exp) {
      lines.push({
        key: k || null, roshen_id: il.roshen_id, item_code: il.item_code, description: il.description,
        kind: 'extra', flags: ['extra'],
        invoiced_cases: invoicedCases, expected_cases: 0,
        case_price: casePrice, expected_case_price: null,
        qty_variance: round(invoicedCases), price_variance: null,
        taxable_amount: taxable, vat_amount: vatAmount, expected_vat: expectedVat,
        tax_variance: vatAmount != null && expectedVat != null ? round(vatAmount - expectedVat) : null,
      });
      return;
    }
    if (k) seen.add(k);

    const priceTolAbs = Math.max(priceTol, exp.po_price * 0.01);
    const taxTolAbs = Math.max(opts.taxTol != null ? opts.taxTol : 1, (taxable || 0) * 0.015);

    const qtyVar = round(invoicedCases - exp.open_to_invoice); // >0 over-invoiced, <0 partial
    const priceVar = casePrice != null ? round(casePrice - exp.po_price) : null;
    const taxVar = vatAmount != null && expectedVat != null ? round(vatAmount - expectedVat) : null;

    const flags = [];
    if (qtyVar > qtyTol) flags.push('qty_variance');               // billed more than remains billable
    if (priceVar != null && !approxEq(casePrice, exp.po_price, priceTolAbs)) flags.push('price_variance');
    if (taxVar != null && !approxEq(vatAmount, expectedVat, taxTolAbs)) flags.push('tax_variance');
    const partial = qtyVar < -qtyTol;                               // under-billed the open balance

    const kind = flags[0] || (partial ? 'partial' : 'matched');
    lines.push({
      key: k, roshen_id: exp.roshen_id || il.roshen_id, item_code: exp.item_code || il.item_code,
      description: exp.description || il.description,
      kind, flags, partial,
      invoiced_cases: invoicedCases, expected_cases: exp.open_to_invoice, delivered_cases: exp.delivered,
      already_invoiced: exp.already_invoiced,
      case_price: casePrice, expected_case_price: exp.po_price,
      qty_variance: qtyVar, price_variance: priceVar,
      taxable_amount: taxable, vat_amount: vatAmount, expected_vat: expectedVat, tax_variance: taxVar,
    });
  });

  // Delivered-but-still-open lines this invoice does not bill → missing (open balance).
  expByKey.forEach((exp, k) => {
    if (seen.has(k)) return;
    if (exp.open_to_invoice <= qtyTol) return; // nothing left to invoice → not missing
    lines.push({
      key: k, roshen_id: exp.roshen_id, item_code: exp.item_code, description: exp.description,
      kind: 'missing', flags: ['missing'], partial: false,
      invoiced_cases: 0, expected_cases: exp.open_to_invoice, delivered_cases: exp.delivered,
      already_invoiced: exp.already_invoiced,
      case_price: null, expected_case_price: exp.po_price,
      qty_variance: round(-exp.open_to_invoice), price_variance: null,
      taxable_amount: 0, vat_amount: 0, expected_vat: round(exp.open_to_invoice * exp.po_price * VAT_RATE), tax_variance: null,
    });
  });

  const count = (kind) => lines.filter((l) => l.kind === kind).length;
  const withFlag = (f) => lines.filter((l) => (l.flags || []).includes(f)).length;
  const invoicedNet = round(lines.reduce((a, l) => a + n(l.taxable_amount), 0));
  const invoicedVat = round(lines.reduce((a, l) => a + n(l.vat_amount), 0));
  const expectedNet = round(lines.reduce((a, l) => a + n(l.expected_cases) * n(l.expected_case_price), 0));

  const hardVariances = withFlag('qty_variance') + withFlag('price_variance') + withFlag('tax_variance') + count('extra');
  const openLines = count('missing') + lines.filter((l) => l.partial).length;

  return {
    lines,
    summary: {
      lines: lines.length,
      matched: count('matched'),
      qty_variance: withFlag('qty_variance'),
      price_variance: withFlag('price_variance'),
      tax_variance: withFlag('tax_variance'),
      missing: count('missing'),
      extra: count('extra'),
      partial: lines.filter((l) => l.partial).length,
      invoicedNet, invoicedVat, expectedNet,
      valueDiff: round(invoicedNet - expectedNet),
      hardVariances, openLines,
      // Strict full match: nothing unbilled/over/extra. Clean partial: no hard
      // variances but some lines still open (missing / under-billed).
      ok: hardVariances === 0 && openLines === 0 && lines.length > 0,
      okPartial: hardVariances === 0 && lines.length > 0,
    },
  };
}
