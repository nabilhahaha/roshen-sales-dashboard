// Table + status-badge + card presentational helpers.
import { esc } from '../../utils/format.js';
import { ORDER_STATUS_VARIANT, ORDER_STATUS_DISPLAY } from '../../models/order-status.js';
import { PI_STATUS_VARIANT } from '../../models/pi-status.js';
import { orderBusinessStatus, BIZ_VARIANT } from '../../models/business-status.js';

// Accepts the raw status string, or the whole order row for exact business
// labelling (a manually closed order shows "Closed", an auto-closed one —
// fully received — shows "Delivered").
export const orderBadge = (s) => {
  if (s && typeof s === 'object') {
    const biz = orderBusinessStatus(s);
    return `<span class="sc-badge ${BIZ_VARIANT[biz] || ORDER_STATUS_VARIANT[s.status] || 'none'}">${esc(biz)}</span>`;
  }
  return `<span class="sc-badge ${ORDER_STATUS_VARIANT[s] || 'none'}">${esc(ORDER_STATUS_DISPLAY[s] || s || '—')}</span>`;
};
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
