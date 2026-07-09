// Shelf-life model — PURE date math. No shelf-life percentage is ever stored;
// every figure here is computed on demand from the batch dates + the SKU's
// shelf-life master data. All calculations are BATCH-level.
//
//   Total shelf life  = manufacturing → expiry span, in days
//                       (if manufacturing date is unknown, the SKU's master
//                        shelf-life value is used as the total instead)
//   Remaining         = today → expiry
//   Remaining %       = remaining / total
//   Consumed %        = 100 − remaining %

const MS_DAY = 86400000;

// Robust date parse: dd.mm.yyyy · dd/mm/yyyy · yyyy-mm-dd · Excel serial · Date.
export function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    // Excel serial day number (1900 date system)
    const n = Number(v);
    if (n > 59 && n < 60000) return new Date(Math.round((n - 25569) * MS_DAY));
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);        // yyyy-mm-dd
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{4})$/);            // dd.mm.yyyy
  if (m) return mk(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{1,2})[-./](\d{1,2})[-./](\d{2})$/);            // dd.mm.yy
  if (m) return mk(2000 + +m[3], +m[2], +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function mk(y, mo, d) { const dt = new Date(Date.UTC(y, mo - 1, d)); return isNaN(dt) ? null : dt; }

export function toISO(d) {
  const dt = parseDate(d);
  return dt ? dt.toISOString().slice(0, 10) : null;
}

// SKU shelf-life master value → days.
export function shelfLifeToDays(value, unit) {
  const v = Number(value);
  if (!v || isNaN(v)) return null;
  if (unit === 'Days') return v;
  if (unit === 'Months') return v * 30;
  if (unit === 'Years') return v * 365;
  return null;
}

// Core calculation for one batch.
// sku: { shelf_life_value, shelf_life_unit, min_remaining_shelf_life_pct }
// batch: { manufacturing_date, expiry_date }
// asOf: Date | string (defaults to now)
export function shelfLife(sku, batch, asOf) {
  const today = parseDate(asOf) || new Date();
  const expiry = parseDate(batch && batch.expiry_date);
  const mfg = parseDate(batch && batch.manufacturing_date);
  const skuDays = shelfLifeToDays(sku && sku.shelf_life_value, sku && sku.shelf_life_unit);

  if (!expiry) return { known: false };

  // total span: prefer actual manufacturing→expiry; else the SKU master value
  let totalDays = mfg ? Math.round((expiry - mfg) / MS_DAY) : skuDays;
  const impliedMfg = mfg || (skuDays ? new Date(expiry.getTime() - skuDays * MS_DAY) : null);
  const remainingDays = Math.round((expiry - today) / MS_DAY);

  let remainingPct = null, consumedPct = null;
  if (totalDays && totalDays > 0) {
    remainingPct = Math.max(0, Math.min(100, (remainingDays / totalDays) * 100));
    consumedPct = +(100 - remainingPct).toFixed(1);
    remainingPct = +remainingPct.toFixed(1);
  }

  const minPct = sku && sku.min_remaining_shelf_life_pct != null ? Number(sku.min_remaining_shelf_life_pct) : null;
  const belowMinimum = minPct != null && remainingPct != null && remainingPct < minPct;

  return {
    known: true,
    expiry, manufacturing: impliedMfg, mfgKnown: !!mfg,
    totalDays: totalDays || null,
    remainingDays,
    remainingPct, consumedPct,
    minPct, belowMinimum,
    expired: remainingDays < 0,
    band: band(remainingPct),
  };
}

// Colour band by remaining %: Green ≥70, Yellow 50–69, Orange 30–49, Red <30.
export function band(pct) {
  if (pct == null) return 'unknown';
  if (pct >= 70) return 'green';
  if (pct >= 50) return 'yellow';
  if (pct >= 30) return 'orange';
  return 'red';
}

export const BAND_COLOR = {
  green: '#2FB344', yellow: '#F2C037', orange: '#F76707', red: '#E03131', unknown: '#8FA3BD',
};
export const BAND_LABEL = {
  green: '≥70%', yellow: '50–69%', orange: '30–49%', red: '<30%', unknown: 'n/a',
};

// Friendly remaining duration, e.g. "6.0 mo" / "45 d" / "1.2 y".
export function humanDuration(days) {
  if (days == null || isNaN(days)) return '—';
  const d = Math.round(days);
  if (Math.abs(d) >= 365) return (d / 365).toFixed(1) + ' y';
  if (Math.abs(d) >= 60) return (d / 30).toFixed(1) + ' mo';
  return d + ' d';
}
