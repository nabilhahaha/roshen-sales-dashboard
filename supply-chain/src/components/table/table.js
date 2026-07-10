// Table + status-badge + card presentational helpers.
import { esc } from '../../utils/format.js';
import { ORDER_STATUS_VARIANT, ORDER_STATUS_DISPLAY } from '../../models/order-status.js';
import { PI_STATUS_VARIANT } from '../../models/pi-status.js';

export const orderBadge = (s) => `<span class="sc-badge ${ORDER_STATUS_VARIANT[s] || 'none'}">${esc(ORDER_STATUS_DISPLAY[s] || s || '—')}</span>`;
export const piBadge = (s) => (s ? `<span class="sc-badge ${PI_STATUS_VARIANT[s] || 'none'}">${esc(s)}</span>` : '<span class="sc-badge none">No PI</span>');

export const emptyState = (icon, text) => `<div class="sc-empty"><div class="ic">${icon}</div><p>${esc(text)}</p></div>`;
export const loading = (text = 'Loading…') => emptyState('⏳', text);
export const card = (inner, cls = '') => `<div class="sc-card ${cls}">${inner}</div>`;
export const tableWrap = (inner) => `<div class="sc-table-wrap">${inner}</div>`;

// columns: [{ label, num?, cls? }]  ; bodyRowsHtml: pre-rendered <tr>…</tr>
export function table(columns, bodyRowsHtml) {
  const head = columns.map((c) => `<th class="${c.num ? 'num' : ''} ${c.cls || ''}">${esc(c.label)}</th>`).join('');
  return tableWrap(`<table class="sc-table"><thead><tr>${head}</tr></thead><tbody>${bodyRowsHtml}</tbody></table>`);
}
