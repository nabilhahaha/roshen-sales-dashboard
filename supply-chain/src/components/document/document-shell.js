// V2 document shell — THE one layout every business document uses
// (Purchase Order / PI, Delivery Note, Supplier Invoice, Warehouse Receipt):
//
//   ┌ header: number · supplier · status badges · date · amount · last update
//   ├ tabs:   Overview · Items · Delivery · Invoices · Documents · Timeline
//   └ grid:   [ active tab content | always-visible quick actions ]
//
// Presentation only: pages pass tab renderers and action handlers; every
// service call stays exactly where it was. Tabs render lazily (one query set
// per tab) so no screen turns into a long scrolling page.
import { esc } from '../../utils/format.js';
import { runAction, skeletonTable, spinner } from '../feedback/feedback.js';

// shell(root, {
//   icon, title, badges (html), meta: [{label, value(html-safe already)}],
//   tabs: [{ id, label, icon, count, render(el) }], activeTab,
//   actions: [{ act, label, primary?, danger? }] , onAction(act, btn),
//   banner (html above tabs)
// })
const TAB_MEMORY = new Map();   // remember the last opened tab per document

export function renderDocumentShell(root, cfg) {
  const tabs = (cfg.tabs || []).filter(Boolean);
  const memKey = cfg.memoryKey || cfg.title || '';
  const remembered = TAB_MEMORY.get(memKey);
  let active = cfg.activeTab && tabs.some((t) => t.id === cfg.activeTab) ? cfg.activeTab
    : (remembered && tabs.some((t) => t.id === remembered) ? remembered : (tabs[0] && tabs[0].id));

  // Smart Action Bar (V2.2): the most-used actions stay inline in the sticky
  // header (primaries first); EVERYTHING is also in the More ▾ menu, so on
  // smaller screens — where the inline buttons progressively hide — every
  // action still takes exactly one click. No side panel: content gets the
  // full width.
  const actions = (cfg.actions || []).filter(Boolean);
  const inline = [...actions.filter((a) => a.primary), ...actions.filter((a) => !a.primary && !a.danger)].slice(0, 4);
  const actBar = `<div class="doc-actbar">
      ${inline.map((a, i) => `<button class="sc-btn sm ${a.primary ? 'green' : 'ghost'} doc-act doc-act-p${i + 1}" data-qact="${a.act}">${esc(a.label)}</button>`).join('')}
      ${actions.length ? `<div class="doc-more-wrap">
        <button class="sc-btn sm ghost" data-el="morebtn">⋯ More ▾</button>
        <div class="doc-more-menu" data-el="moremenu" style="display:none">
          ${actions.map((a) => `<button class="doc-more-item" ${a.danger ? 'style="color:#E03131"' : ''} data-qact="${a.act}">${esc(a.label)}</button>`).join('')}
        </div></div>` : ''}
    </div>`;

  root.innerHTML = `
    <div class="doc-head">
      <div class="doc-head-top">
        <h2>${cfg.icon || '📄'} ${esc(cfg.title || '')}</h2>
        ${cfg.badges || ''}
        <div class="sc-spacer" style="margin-left:auto"></div>
        ${actBar}
        ${cfg.headRight || ''}
      </div>
      ${(cfg.meta || []).length ? `<div class="doc-head-meta">${cfg.meta.map((m) => (m && m.value != null && m.value !== '')
        ? `<div class="m"><div class="l">${esc(m.label)}</div><div class="v">${m.html ? m.value : esc(String(m.value))}</div></div>` : '').join('')}</div>` : ''}
      <div class="doc-tabs" data-el="tabs">
        ${tabs.map((t) => `<button class="doc-tab${t.id === active ? ' active' : ''}" data-tab="${t.id}">
          ${t.icon || ''} ${esc(t.label)}${t.count != null ? ` <span class="cnt">${t.count}</span>` : ''}</button>`).join('')}
      </div>
    </div>
    ${cfg.banner || ''}
    <div data-el="tabbody" style="min-width:0"></div>`;

  // More ▾ menu open/close
  const moreBtn = root.querySelector('[data-el="morebtn"]');
  const moreMenu = root.querySelector('[data-el="moremenu"]');
  if (moreBtn && moreMenu) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      moreMenu.style.display = moreMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => { if (!moreMenu.contains(e.target) && e.target !== moreBtn) moreMenu.style.display = 'none'; });
  }

  const bodyEl = root.querySelector('[data-el="tabbody"]');
  async function show(id) {
    active = id;
    if (memKey) TAB_MEMORY.set(memKey, id);
    root.querySelectorAll('.doc-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    const t = tabs.find((x) => x.id === id);
    bodyEl.innerHTML = `<div class="sk-page" role="status" aria-live="polite">
      <div class="sk-page-head">${spinner()} <span>Loading…</span></div>
      <div class="sc-card">${skeletonTable(5, 6)}</div></div>`;
    try { await t.render(bodyEl); }
    catch (e) { bodyEl.innerHTML = `<div class="sc-empty"><div class="ic">⚠</div><p>${esc(e.message || String(e))}</p></div>`; }
  }
  root.querySelectorAll('.doc-tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  root.querySelectorAll('[data-qact]').forEach((b) => b.addEventListener('click', () => {
    if (moreMenu) moreMenu.style.display = 'none';
    if (cfg.onAction) runAction(() => cfg.onAction(b.dataset.qact, b), b.dataset, b);
  }));
  if (active) show(active);
  return { show, body: bodyEl, get active() { return active; } };
}

// ---- in-page drawer (previews, business file) — the user never leaves ------
export function openDrawer(title, bodyHtml) {
  closeDrawer();
  const o = document.createElement('div');
  o.className = 'doc-drawer-overlay';
  o.innerHTML = `<div class="doc-drawer">
    <div class="doc-drawer-h"><h3>${esc(title)}</h3><div class="sc-spacer" style="margin-left:auto"></div>
      <button class="sc-btn sm ghost" data-el="close">✕ Close</button></div>
    <div class="doc-drawer-b" data-el="body">${bodyHtml || ''}</div></div>`;
  o.addEventListener('click', (e) => { if (e.target === o) closeDrawer(); });
  o.querySelector('[data-el="close"]').addEventListener('click', closeDrawer);
  document.body.appendChild(o);
  document.addEventListener('keydown', escClose);
  return o.querySelector('[data-el="body"]');
}
export function closeDrawer() {
  document.querySelectorAll('.doc-drawer-overlay').forEach((n) => n.remove());
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeDrawer(); }
