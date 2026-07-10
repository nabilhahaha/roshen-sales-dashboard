// Regression tests: written-number locale handling in document imports.
// Guards against the KS-393/2026 incident where the DN quantity "1,260"
// (US-format text cell) was parsed as 1.26 and flowed into receiving,
// inventory and the PO fulfillment figures.
// Run: node supply-chain/tests/number-locale.test.mjs   (no dependencies)
import { parseNumber, detectNumberLocale } from '../src/utils/format.js';
import { buildDeliveryNote } from '../src/services/delivery-note/dn-validator.js';
import { parseOrderWorkbook } from '../src/services/import/excel-order-parser.js';

let pass = 0, fail = 0;
const ok = (c, n, x) => { if (c) { pass++; console.log(' ✔', n); } else { fail++; console.log(' ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

// ---- document locale detection ---------------------------------------------
ok(detectNumberLocale(['1.234,56', '4050,00']) === 'eu', 'EU from comma decimals');
ok(detectNumberLocale(['1,234.56', '4050.00']) === 'us', 'US from dot decimals');
ok(detectNumberLocale(['1,260', '1,856']) === 'us', 'US from single comma-3-digit groups (the incident format)');
ok(detectNumberLocale(['1.260', '1.856']) === 'eu', 'EU symmetric');
ok(detectNumberLocale(['546', '365']) === null, 'plain integers claim no locale');
ok(detectNumberLocale(['06.02.2028', '13.07.2027']) === null, 'dotted dates are not number-locale evidence');

// ---- parseNumber under a document locale -------------------------------------
ok(parseNumber('1,260', 'us') === 1260, '"1,260" US → 1260 (was 1.26 before the fix)');
ok(parseNumber('1,715', 'us') === 1715, '"1,715" US → 1715');
ok(parseNumber('1.260', 'eu') === 1260, '"1.260" EU → 1260');
ok(parseNumber('1.234.567,89', 'eu') === 1234567.89, 'full EU form');
ok(parseNumber('1,234,567.89', 'us') === 1234567.89, 'full US form');
ok(parseNumber('88,14', 'eu') === 88.14, 'EU comma decimal');
ok(parseNumber('88.14', 'us') === 88.14, 'US dot decimal');
ok(parseNumber(1260, 'eu') === 1260, 'typed numbers pass through untouched');
ok(parseNumber('1,234.50') === 1234.5, 'no locale: last separator is the decimal (US)');
ok(parseNumber('1.234,50') === 1234.5, 'no locale: last separator is the decimal (EU)');

// ---- typed Excel cells beat display formatting --------------------------------
// stubbed XLSX: a worksheet whose TYPED value is 1260 but whose display text is
// "1.260" (EU) / "1,260" (US) — the typed value must win either way.
function stubXLSX(displayGrid, typedGrid) {
  return {
    read: () => ({ SheetNames: ['S'], Sheets: { S: {} } }),
    utils: { sheet_to_json: (ws, opts) => (opts && opts.raw ? typedGrid : displayGrid) },
  };
}
{
  const display = [['Roshen ID', 'Cartons'], ['9100004715', '1.260'], ['9100001282', '546']];
  const typed = [['Roshen ID', 'Cartons'], ['9100004715', 1260], ['9100001282', 546]];
  const parsed = parseOrderWorkbook(new ArrayBuffer(0), stubXLSX(display, typed));
  ok(parsed.rows[0][1] === 1260, 'numeric cell displayed "1.260" → 1260 (typed value wins)', parsed.rows[0][1]);
}
{
  // numeric↔display PAIR evidence sets the document locale for its TEXT cells:
  // total cell v=2080 shown "2,080" proves comma = thousands → "1,715" = 1715
  const display = [['Roshen ID', 'Cartons'], ['9100004890', '1,715'], ['9100004890', '365'], ['TOTAL', '2,080']];
  const typed = [['Roshen ID', 'Cartons'], ['9100004890', '1,715'], ['9100004890', '365'], ['TOTAL', 2080]];
  const parsed = parseOrderWorkbook(new ArrayBuffer(0), stubXLSX(display, typed));
  ok(parsed.numberLocale === 'us', 'pair evidence (v=2080 shown "2,080") fixes the locale', parsed.numberLocale);
  ok(parseNumber(parsed.rows[0][1], parsed.numberLocale) === 1715, 'text "1,715" then parses as 1715');
}
{
  // dates come through as ISO days, not serial numbers
  const d = new Date(2027, 0, 5);
  const display = [['Expiry'], ['05.01.2027']];
  const typed = [['Expiry'], [d]];
  const parsed = parseOrderWorkbook(new ArrayBuffer(0), stubXLSX(display, typed));
  ok(parsed.rows[0][0] === '2027-01-05', 'date cell → ISO day', parsed.rows[0][0]);
}

// ---- end-to-end through the DN validator --------------------------------------
{
  const rows = [
    { __row: 2, 0: '9100004715', 1: 'Johnny Krocker', 2: '1,260' },
    { __row: 3, 0: '9100001282', 1: 'Mintex Mint', 2: '546' },
  ];
  const built = buildDeliveryNote({ rows, mapByIdx: { 0: 'roshen_id', 1: 'description', 2: 'cartons' },
    skuIndex: {}, fulfillment: [], asOf: '2026-07-10', numberLocale: 'us' });
  const byKey = {}; built.lines.forEach((l) => { byKey[l.roshen_id] = l.totalCases; });
  ok(byKey['9100004715'] === 1260 && byKey['9100001282'] === 546, 'DN validator receives correct quantities', byKey);
  ok((built.summary.fractionalQty || []).length === 0, 'no fractional-carton warning on clean data');
}
{
  // a fractional carton quantity raises the red-flag warning (never auto-fixed)
  const rows = [{ __row: 2, 0: '9100004715', 1: 'X', 2: 1.26 }];
  const built = buildDeliveryNote({ rows, mapByIdx: { 0: 'roshen_id', 1: 'description', 2: 'cartons' },
    skuIndex: {}, fulfillment: [], asOf: '2026-07-10' });
  ok(built.summary.fractionalQty.length === 1 && built.summary.fractionalQty[0].cases === 1.26,
    'fractional carton quantity is flagged for the reviewer', built.summary.fractionalQty);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
