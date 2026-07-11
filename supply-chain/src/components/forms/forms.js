// Form field + searchable combobox helpers (presentational).
import { esc, money } from '../../utils/format.js';

export const field = (label, innerHtml) =>
  `<div class="sc-field"><label>${esc(label)}</label>${innerHtml}</div>`;

export const readonlyField = (label, value) =>
  field(label, `<input class="sc-input" readonly value="${esc(value == null || value === '' ? '—' : value)}">`);

// A searchable SKU combobox. Renders into `mountEl` and calls onPick(item_code).
// Data: skus [{ item_code, roshen_id, item_description, price_case }].
export function createSkuCombo(mountEl, skus, onPick) {
  mountEl.classList.add('sc-combo');
  mountEl.innerHTML =
    '<input class="sc-input" data-el="search" placeholder="🔎 Search item by code or description…" autocomplete="off">' +
    '<div class="sc-combo-drop" data-el="drop"></div>';
  const search = mountEl.querySelector('[data-el="search"]');
  const drop = mountEl.querySelector('[data-el="drop"]');
  let matches = [];

  function filter(q) {
    q = (q || '').trim().toLowerCase();
    let list = skus;
    if (q) list = skus.filter((s) =>
      (s.item_code || '').toLowerCase().includes(q) ||
      (s.item_description || '').toLowerCase().includes(q) ||
      String(s.roshen_id || '').includes(q));
    matches = list.slice(0, 60);
    if (!matches.length) { drop.innerHTML = '<div class="sc-combo-empty">No matching SKU</div>'; mountEl.classList.add('open'); return; }
    drop.innerHTML = matches.map((s, i) =>
      `<div class="sc-combo-opt${i === 0 ? ' active' : ''}" data-code="${esc(s.item_code)}">
        <div class="code">${esc(s.item_code)} &nbsp;·&nbsp; <span style="color:var(--text-muted)">Roshen ${esc(s.roshen_id || '—')}</span></div>
        <div class="desc">${esc(s.item_description || '')}</div>
        <div class="meta">${money(s.price_case)} SAR / case</div>
      </div>`).join('');
    mountEl.classList.add('open');
  }

  drop.addEventListener('mousedown', (e) => {
    const opt = e.target.closest('.sc-combo-opt');
    if (!opt) return;
    e.preventDefault();
    onPick(opt.dataset.code);
    search.value = '';
    mountEl.classList.remove('open');
    search.focus();
  });
  search.addEventListener('input', () => filter(search.value));
  search.addEventListener('focus', () => filter(search.value));
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); if (matches.length) { onPick(matches[0].item_code); search.value = ''; mountEl.classList.remove('open'); } }
    else if (e.key === 'Escape') mountEl.classList.remove('open');
  });
  const onDocClick = (e) => {
    // self-detach once this combo instance leaves the DOM
    if (!mountEl.isConnected) { document.removeEventListener('click', onDocClick); return; }
    if (!mountEl.contains(e.target)) mountEl.classList.remove('open');
  };
  document.addEventListener('click', onDocClick);

  return { focus: () => search.focus() };
}
