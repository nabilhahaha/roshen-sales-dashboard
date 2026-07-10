// Presentational badge helpers for the Delivery-Note / receiving / inventory
// screens: shelf-life colour band, QC state, and generic fulfillment status.
import { esc, qty } from '../../utils/format.js';
import { BAND_COLOR, humanDuration } from '../../models/shelf-life.js';
import { STATUS_VARIANT, STATUS_DISPLAY, QC_COLOR } from '../../models/fulfillment-status.js';

// Coloured remaining shelf-life chip from a shelfLife() result.
export function shelfChip(sl) {
  if (!sl || !sl.known || sl.remainingPct == null) return '<span class="sc-badge none">n/a</span>';
  const c = BAND_COLOR[sl.band] || BAND_COLOR.unknown;
  const flag = sl.belowMinimum ? ' title="Below receiving shelf life requirement"' : '';
  return `<span class="sc-shelf" style="--sl:${c}"${flag}>${sl.remainingPct}% · ${humanDuration(sl.remainingDays)}${sl.belowMinimum ? ' ⚠' : ''}</span>`;
}

export const qcBadge = (s) =>
  `<span class="sc-badge" style="background:${(QC_COLOR[s] || '#8FA3BD')}22;color:${QC_COLOR[s] || '#8FA3BD'};border-color:${(QC_COLOR[s] || '#8FA3BD')}55">${esc(s || '—')}</span>`;

export const statusBadge = (s) =>
  `<span class="sc-badge ${STATUS_VARIANT[s] || 'none'}">${esc(STATUS_DISPLAY[s] || s || '—')}</span>`;

// A compact ordered→delivered→received cell.
export const flowCell = (o, d, r) =>
  `<span class="mono">${qty(o)}</span> <span style="color:var(--text-muted)">→</span> ${qty(d)} <span style="color:var(--text-muted)">→</span> ${qty(r)}`;
