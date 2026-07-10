// Supplier-invoice PDF parser. Supplier invoices are received as the supplier's
// own PDF (bilingual EN/AR for ZATCA), so we read the text with pdf.js and
// extract the header, totals and line items heuristically. Extraction is
// best-effort — the UI always lets the user verify/correct before matching, and
// the original PDF is kept for audit. Pure aside from the injected pdfjsLib.

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// strip non-latin (Arabic + bidi marks) so English labels/values parse cleanly
const latin = (s) => String(s || '').replace(/[^\x00-\x7F]/g, ' ').replace(/\s+/g, ' ').trim();
const numsIn = (s) => (String(s).match(/-?\d[\d,]*\.?\d*/g) || []).map((x) => Number(x.replace(/,/g, ''))).filter((n) => !isNaN(n));

function isoDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// pdf.js document → array of visual lines (top-to-bottom), latin-cleaned.
export async function pdfToLines(pdfjsLib, arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer), useSystemFonts: true }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const by = {};
    tc.items.forEach((it) => { if (!it.str) return; const y = Math.round(it.transform[5]); (by[y] = by[y] || []).push({ x: Math.round(it.transform[4]), s: it.str }); });
    Object.keys(by).map(Number).sort((a, b) => b - a).forEach((y) => {
      const raw = by[y].sort((a, b) => a.x - b.x).map((c) => c.s).join(' ');
      lines.push({ page: p, raw, text: latin(raw) });
    });
  }
  return lines;
}

// Pure: extract header / totals / line items from the cleaned lines.
export function parseInvoiceLines(lines) {
  const find = (re) => { for (const l of lines) { const m = l.text.match(re); if (m) return m; } return null; };
  const findLine = (re) => lines.find((l) => re.test(l.text));

  const invoice_number = (find(/Invoice\s*#\s*:?\s*([A-Za-z0-9][\w\-\/]+)/) || [])[1] || null;
  const invoice_date = isoDate((find(/Invoice\s*Issue\s*Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i) || [])[1]);
  const due_date = isoDate((find(/Due\s*Date\s*:?\s*(\d{1,2}\s+[A-Za-z]{3,}\s+\d{4})/i) || [])[1]);
  // payment terms, e.g. "Terms: Net 45"
  const payment_terms = ((find(/\bTerms\s*:\s*([A-Za-z0-9][A-Za-z0-9 ]{1,22})/) || [])[1] || '').trim() || null;
  // title-case run after "Company" (stops before single-letter bidi noise)
  const supplier = ((find(/Company\s+([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+)*)/) || [])[1] || '').trim() || null;
  // buyer: a "... Company" title-case run that is not the seller (best-effort)
  let buyer = null;
  for (const l of lines) {
    const m = l.text.match(/([A-Z][A-Za-z&'.-]+(?:\s+[A-Z][A-Za-z&'.-]+){1,3}\s+Company)/);
    if (m && (!supplier || !m[1].includes(supplier))) { buyer = m[1].trim(); break; }
  }

  // ZATCA registrations: the document shows TRNs seller-first; the CRN sits in
  // the buyer/seller block wherever the layout put it — captured verbatim.
  const trns = [];
  lines.forEach((l) => (l.text.match(/TRN\s*(\d{10,15})/g) || []).forEach((t) => {
    const n = t.replace(/\D/g, ''); if (!trns.includes(n)) trns.push(n);
  }));
  const seller_vat = trns[0] || null;
  const buyer_vat = trns[1] || null;
  const seller_cr = (find(/CRN\s*(\d{6,15})/) || [])[1] || null;

  // Notes block: the first free-text line after the "Notes" label.
  let doc_notes = null;
  const notesIdx = lines.findIndex((l) => /^Notes\b/.test(l.text));
  if (notesIdx >= 0) {
    for (let i = notesIdx + 1; i < lines.length; i++) {
      const t = lines[i].text.trim();
      if (t && !/^\d+$/.test(t)) { doc_notes = t; break; }
    }
  }

  // Subject line carries the PO / DN references (e.g. "KS-417 DN-761")
  const subj = findLine(/\bDN-\d+|\bKS-\d+|\bPO[-\s]?\d+/i);
  const po_reference = subj ? (subj.text.match(/\b([A-Z]{2,4}-\d+)/) || [])[1] : null;
  const dn_reference = subj ? (subj.text.match(/\b(DN-\d+)/i) || [])[1] : null;

  // A total label's amount is the LAST monetary token on its line — bilingual
  // transliteration can inject stray single digits before the real number.
  const lastMoney = (re) => {
    const line = findLine(re);
    if (!line) return null;
    const all = line.text.match(/\d[\d,]*\.\d{2}/g);
    return all && all.length ? Number(all[all.length - 1].replace(/,/g, '')) : null;
  };
  const totals = {
    taxable: lastMoney(/Total\s+Taxable\s+Amount/i),
    vat: lastMoney(/Total\s+VAT/i),
    grand: lastMoney(/Total\s+Amount\s+Due/i) || lastMoney(/Balance\s+Due/i),
  };
  if (totals.grand == null && totals.taxable != null && totals.vat != null) totals.grand = +(totals.taxable + totals.vat).toFixed(2);

  // Line items: a row that starts with an item index and carries >= 5 numbers.
  // The last five numbers are the financial columns:
  //   [unit_price, quantity, taxable_amount, tax_amount, line_total]
  const items = [];
  lines.forEach((l) => {
    const m = l.text.match(/^(\d{1,3})\s+(.+)/);
    if (!m) return;
    // Capture and strip any per-line tax-rate token (e.g. "15%" / "15.00%") so
    // it never contaminates the financial-column extraction below.
    const pctMatch = m[2].match(/(\d{1,2}(?:\.\d+)?)\s*%/);
    const body = m[2].replace(/\d{1,2}(?:\.\d+)?\s*%/g, ' ');
    const n = numsIn(body);
    if (n.length < 5) return;
    const [unit_price, quantity, taxable_amount, vat_amount, line_total] = n.slice(-5);
    if (!(taxable_amount > 0)) return;
    const description = body.replace(/[\d.,]+/g, ' ').replace(/\bSAR\b/gi, ' ').replace(/\s+/g, ' ').trim();
    const vat_percent = pctMatch ? Number(pctMatch[1])
      : (taxable_amount ? Math.round((vat_amount / taxable_amount) * 100) : null);
    items.push({ idx: Number(m[1]), description, unit_price, quantity, taxable_amount, vat_amount, line_total, vat_percent });
  });

  return {
    header: {
      invoice_number, invoice_date, due_date, payment_terms, supplier, buyer,
      seller_vat, seller_cr, buyer_vat, doc_notes,
      po_reference, dn_reference, currency: 'SAR',
    },
    totals, lines: items,
    rawText: lines.map((l) => l.text).filter(Boolean).join('\n'),
  };
}

export async function parseInvoicePdf(arrayBuffer, pdfjsLib) {
  const lines = await pdfToLines(pdfjsLib, arrayBuffer);
  return parseInvoiceLines(lines);
}
