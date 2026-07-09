// Supplier-invoice ↔ Delivery-Note validation (pure).
//
// A supplier invoice carries no Item Code / Roshen ID and is priced per piece,
// while the DN is expressed in cartons — so lines are reconciled at the VALUE
// level: the invoice's net (taxable) is compared against the DN's expected net
// (delivered cartons × PO case price). Document references (DN / PO) are checked
// for identity. Line-to-SKU binding is done by the user in the validation
// screen — the system never silently matches by description.
import { approxEq } from '../../utils/format.js';

const digits = (s) => String(s || '').replace(/\D/g, '');

// dnCtx: { dnNumber, poReference, expectedNet, lineCount }
// parsed: output of the invoice parser (header + totals + lines)
export function compareInvoiceToDeliveryNote(parsed, dnCtx) {
  const invoiceNet = Number((parsed.totals && parsed.totals.taxable) || 0);
  const invoiceVat = Number((parsed.totals && parsed.totals.vat) || 0);
  const expectedNet = Number(dnCtx.expectedNet || 0);
  const tol = Math.max(1, expectedNet * 0.01); // 1% or 1 SAR

  const dnRef = parsed.header && parsed.header.dn_reference;
  const poRef = parsed.header && parsed.header.po_reference;
  const refOk = dnRef ? digits(dnRef) === digits(dnCtx.dnNumber) : null;
  const poOk = poRef && dnCtx.poReference ? digits(poRef) === digits(dnCtx.poReference) : null;

  const valueOk = approxEq(invoiceNet, expectedNet, tol);
  const vatOk = approxEq(invoiceVat, invoiceNet * 0.15, Math.max(1, invoiceNet * 0.015));

  const checks = [
    { key: 'dn_ref', label: 'Delivery-note reference', expected: dnCtx.dnNumber, actual: dnRef || '—', ok: refOk },
    { key: 'po_ref', label: 'PO reference', expected: dnCtx.poReference || '—', actual: poRef || '—', ok: poOk },
    { key: 'value', label: 'Net value (vs DN expected)', expected: expectedNet, actual: invoiceNet, ok: valueOk },
    { key: 'vat', label: 'VAT (15%)', expected: +(invoiceNet * 0.15).toFixed(2), actual: invoiceVat, ok: vatOk },
    { key: 'lines', label: 'Line count', expected: dnCtx.lineCount, actual: (parsed.lines || []).length, ok: dnCtx.lineCount === (parsed.lines || []).length },
  ];

  // Critical checks that gate a clean match: the net value, plus any document
  // reference that is present must AGREE — a DN/PO reference that actively
  // contradicts fails the match (a null/unparsed reference is advisory only).
  const critical = checks.filter((c) =>
    c.key === 'value' ||
    (c.key === 'dn_ref' && refOk !== null) ||
    (c.key === 'po_ref' && poOk !== null));
  const ok = critical.every((c) => c.ok);

  return {
    ok, invoiceNet, expectedNet, invoiceVat, valueDiff: +(invoiceNet - expectedNet).toFixed(2),
    checks, differences: checks.filter((c) => c.ok === false).length,
  };
}
