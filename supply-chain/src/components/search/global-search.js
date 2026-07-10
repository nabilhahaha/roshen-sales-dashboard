// Global-search dropdown for the topbar — instant grouped results while
// typing (debounced), one click opens the document. Presentation only; the
// matching lives in services/search/global-search.service.js.
import { esc } from '../../utils/format.js';
import { globalSearch } from '../../services/search/global-search.service.js';

export function attachGlobalSearch(inputEl, navigate) {
  if (!inputEl) return;
  const holder = inputEl.closest('.erp-search') || inputEl.parentElement;
  holder.style.position = 'relative';
  const drop = document.createElement('div');
  drop.className = 'erp-search-results';
  drop.style.cssText = 'position:absolute;top:calc(100% + 6px);left:0;right:0;min-width:420px;max-height:65vh;overflow:auto;'
    + 'background:var(--bg-card,#1a2233);border:1px solid var(--border,#2c3a52);border-radius:10px;'
    + 'box-shadow:0 12px 30px rgba(0,0,0,.35);z-index:300;display:none;padding:6px';
  holder.appendChild(drop);

  let timer = null, seq = 0;
  const close = () => { drop.style.display = 'none'; };
  const open = () => { drop.style.display = 'block'; };

  async function run(q) {
    const my = ++seq;
    if (!q || q.trim().length < 2) { close(); return; }
    drop.innerHTML = '<div style="padding:10px;font-size:12px;color:var(--text-muted)">Searching…</div>'; open();
    let res;
    try { res = await globalSearch(q); } catch (e) { close(); return; }
    if (my !== seq) return;                                     // a newer keystroke won
    if (!res.groups.length) {
      drop.innerHTML = `<div style="padding:10px;font-size:12px;color:var(--text-muted)">No matches for “${esc(res.query)}” across purchase orders, delivery notes, invoices, receipts, SKUs, batches or files.</div>`;
      return;
    }
    drop.innerHTML = res.groups.map((g) => `
      <div style="padding:6px 8px 2px;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted)">${g.icon} ${esc(g.label)}</div>
      ${g.items.map((it, i) => `<button class="erp-gs-item" data-nav='${esc(JSON.stringify(it.nav))}'
        style="display:block;width:100%;text-align:left;background:none;border:0;padding:7px 10px;border-radius:7px;cursor:pointer;color:var(--text-primary)">
        <b class="mono" style="font-size:12.5px">${esc(it.title)}</b>
        <span style="font-size:11px;color:var(--text-secondary);margin-left:8px">${esc(it.sub || '')}</span></button>`).join('')}`).join('');
    drop.querySelectorAll('.erp-gs-item').forEach((b) => {
      b.addEventListener('mouseenter', () => { b.style.background = 'rgba(25,113,194,.14)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'none'; });
      b.addEventListener('click', () => {
        const [section, params] = JSON.parse(b.dataset.nav);
        close(); inputEl.value = '';
        navigate(section, params);
      });
    });
  }

  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => run(inputEl.value), 280);          // instant-feel, one query per pause
  });
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.addEventListener('click', (e) => { if (!holder.contains(e.target)) close(); });
}
