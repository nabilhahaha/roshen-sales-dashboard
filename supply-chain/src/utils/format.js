// Formatting + small pure helpers shared across the Supply Chain app.

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const money = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const qty = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export const num = (v) =>
  v == null || isNaN(v) ? '0' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const approxEq = (a, b, eps = 0.01) =>
  a != null && b != null && Math.abs(Number(a) - Number(b)) <= eps;

// Normalise a Roshen ID for matching: trim and drop leading zeros so the same
// SKU compares equal whether a document prints it zero-padded ("0000510240")
// or bare ("510240"). Non-numeric ids are only trimmed.
export const normRoshen = (r) => {
  const s = String(r == null ? '' : r).trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
};

// The single line-matching key across PO / DN / invoice / GR lines: Roshen ID
// first, else Item Code — never description. Empty string means "no key".
// Canonical document-reference comparison. Supplier documents often cite a
// reference WITHOUT the year suffix (invoice says "DN-745" / "KS-406" for the
// documents "DN-745/2026" / "KS-406/2026") — these are the same business
// document. Matches when equal (case/whitespace-insensitive) or when one side
// continues the other with "/…". Genuinely different numbers still differ
// (DN-745 vs DN-761, DN-745 vs DN-7451).
export const docRefMatches = (a, b) => {
  if (a == null || b == null) return false;
  const na = String(a).trim().toLowerCase(), nb = String(b).trim().toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + '/') || nb.startsWith(na + '/');
};

export const lineKey = (roshen, code) =>
  normRoshen(roshen) || String(code == null ? '' : code).trim();

// Loose number parse (handles "1,234.50", "1.234,50", "1 200", currency text).
export function parseNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/\s/g, '').trim();
  if (!s) return null;
  s = s.replace(/[^0-9.,\-]/g, '');
  const hasComma = s.includes(','), hasDot = s.includes('.');
  if (hasComma && hasDot) s = s.replace(/\./g, '').replace(',', '.');
  else if (hasComma) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
