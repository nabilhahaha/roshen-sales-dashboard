// PI ↔ Purchase-Order comparison engine (pure).
//
// Matches imported PI lines to approved-order lines by Item Code, then Roshen
// ID (never by description). Compares at the case / net (pre-VAT) level, which
// is the level the purchase order is expressed in: PI case price = taxable / box,
// PI case quantity = box/pcs, PI line net = taxable amount. Amount tolerance is
// rounding-aware because fractional case counts make qty×price differ slightly.
import { approxEq } from '../../utils/format.js';

// orderLines: [{ item_code, roshen_id, description, cases, case_price, line_total }]
// parsed:     result of pi-parser.parseGrid()
export function comparePiToOrder(orderLines, parsed) {
  const piItems = parsed.items.slice();
  const byCode = {}, byRoshen = {};
  piItems.forEach((p) => {
    if (p.pi_item_code) byCode[String(p.pi_item_code).trim()] = p;
    if (p.roshen_id) byRoshen[String(p.roshen_id).trim()] = p;
  });

  const usedPi = new Set();
  const rows = [];
  orderLines.forEach((o) => {
    const p = (o.item_code && byCode[o.item_code]) || (o.roshen_id && byRoshen[o.roshen_id]) || null;
    if (p) usedPi.add(p);
    if (!p) { rows.push({ order: o, pi: null, kind: 'missing' }); return; }
    const qtyOk = approxEq(o.cases, p.box_pcs, 0.01);
    const priceOk = approxEq(o.case_price, p.case_price, 0.01);
    // amount is derived (qty×price); tolerate rounding from fractional case counts
    const amtOk = approxEq(o.line_total, p.taxable_amount, Math.max(0.5, Math.abs(Number(p.taxable_amount || 0)) * 0.002));
    const kind = qtyOk && priceOk && amtOk ? 'matched' : !priceOk ? 'price_diff' : !qtyOk ? 'qty_diff' : 'amount_diff';
    rows.push({ order: o, pi: p, kind, qtyOk, priceOk, amtOk });
  });
  piItems.forEach((p) => { if (!usedPi.has(p)) rows.push({ order: null, pi: p, kind: 'additional' }); });

  const orderNet = orderLines.reduce((a, b) => a + b.line_total, 0);
  const orderCases = orderLines.reduce((a, b) => a + b.cases, 0);
  const piNet = parsed.totals.total_taxable != null ? parsed.totals.total_taxable : piItems.reduce((a, b) => a + (b.taxable_amount || 0), 0);
  const piCases = piItems.reduce((a, b) => a + (b.box_pcs || 0), 0);

  const summary = {
    matched: rows.filter((r) => r.kind === 'matched').length,
    different: rows.filter((r) => ['qty_diff', 'price_diff', 'amount_diff'].includes(r.kind)).length,
    missing: rows.filter((r) => r.kind === 'missing').length,
    additional: rows.filter((r) => r.kind === 'additional').length,
    qtyDiff: +(piCases - orderCases).toFixed(2),
    valueDiff: +(piNet - orderNet).toFixed(2),
    orderNet: +orderNet.toFixed(2),
    piNet: +piNet.toFixed(2),
    orderCases: +orderCases.toFixed(2),
    piCases: +piCases.toFixed(2),
    grandDiff: +(piNet - orderNet).toFixed(2),
  };
  summary.ok = summary.different === 0 && summary.missing === 0 && summary.additional === 0;
  return { rows, summary };
}

export const KIND_LABEL = {
  matched: '✓ Match',
  qty_diff: '✗ Quantity',
  price_diff: '✗ Price',
  amount_diff: '✗ Amount',
  missing: '✗ Missing in PI',
  additional: '✗ Extra in PI',
};
