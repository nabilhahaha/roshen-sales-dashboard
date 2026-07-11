// Formatting + small pure helpers shared across the Supply Chain app.
// Number and date presentation honour the user's Settings (Settings page):
// digits stay WESTERN in every language (per the Arabic spec: numbers remain
// English) — the setting only chooses the separator convention.
import { getSettings } from '../services/settings/settings.service.js';

export const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// '1,234.56' → en-US grouping · '1.234,56' → de-DE grouping (western digits)
const numLocale = () => (getSettings().numberFormat === '1.234,56' ? 'de-DE' : 'en-US');

export const money = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString(numLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const qty = (v) =>
  v == null || isNaN(v) ? '—' : Number(v).toLocaleString(numLocale(), { maximumFractionDigits: 2 });

export const num = (v) =>
  v == null || isNaN(v) ? '0' : Number(v).toLocaleString(numLocale(), { maximumFractionDigits: 0 });

// present an ISO day (YYYY-MM-DD…) in the user's chosen date format
export const fmtDay = (iso) => {
  const s = String(iso || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  const f = getSettings().dateFormat;
  if (f === 'DD/MM/YYYY') return `${m[3]}/${m[2]}/${m[1]}`;
  if (f === 'MM/DD/YYYY') return `${m[2]}/${m[3]}/${m[1]}`;
  return s;
};

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

// ---- number-format locale ------------------------------------------------
// Documents arrive in two written number formats:
//   EU  1.260  ·  1.234.567,89  ·  4050,00   (dot = thousands, comma = decimal)
//   US  1,260  ·  1,234,567.89  ·  4050.00   (comma = thousands, dot = decimal)
// A lone separator ("1.260") is AMBIGUOUS in isolation — so the locale is
// detected once per DOCUMENT from all of its number strings, and every value
// in that document is then parsed with that locale. This respects the source
// format instead of guessing per cell.
export function detectNumberLocale(values) {
  let eu = 0, us = 0;
  for (const v of values || []) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) eu += 3;        // 1.234,56 — unambiguous
    else if (/^-?\d{1,3}(,\d{3})+\.\d+$/.test(s)) us += 3;   // 1,234.56 — unambiguous
    else if (/^-?\d+,\d{1,2}$/.test(s)) eu += 2;             // 4050,00 — comma decimal
    else if (/^-?\d+\.\d{1,2}$/.test(s)) us += 2;            // 4050.00 — dot decimal
    else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(s)) eu += 3;    // 1.234.567 — repeated groups
    else if (/^-?\d{1,3}(,\d{3}){2,}$/.test(s)) us += 3;     // 1,234,567
    else if (/^-?\d{1,3},\d{3}$/.test(s)) us++;              // 1,260 — comma + exactly 3 digits
    else if (/^-?\d{1,3}\.\d{3}$/.test(s)) eu++;             //  reads as a grouped integer
  }
  return eu > us ? 'eu' : us > eu ? 'us' : null;
}

// Loose number parse (handles "1,234.50", "1.234,50", "1 200", currency text).
// With a detected document locale, separators are interpreted per that locale —
// so "1.260" is 1260 in an EU document and 1.26 in a US one.
export function parseNumber(v, locale) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  let s = String(v).replace(/\s/g, '').trim();
  if (!s) return null;
  s = s.replace(/[^0-9.,\-]/g, '');
  if (!s) return null;
  if (locale === 'eu') s = s.replace(/\./g, '').replace(',', '.');
  else if (locale === 'us') s = s.replace(/,/g, '');
  else {
    const hasComma = s.includes(','), hasDot = s.includes('.');
    if (hasComma && hasDot) {
      // both separators: the LAST one is the decimal point in either format
      if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');          // 1,234.50
      else s = s.replace(/\./g, '').replace(',', '.');                               // 1.234,50
    } else if (hasComma) s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}
