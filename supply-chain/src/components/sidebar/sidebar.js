// Left sidebar — renders the navigation model.
import { esc } from '../../utils/format.js';
import { NAV, labelOf } from '../../models/navigation.js';

export function sidebarHtml() {
  return `
    <aside class="erp-sidebar">
      <div class="erp-brand">
        <div class="erp-brand-logo">🏭</div>
        <div class="erp-brand-text"><b>Roshen / Relia</b><span>Supply Chain</span></div>
      </div>
      <nav class="erp-nav">
        ${NAV.map((g) => {
          const items = g.items.filter((i) => !i.hidden);
          if (!items.length) return '';
          return `
          <div class="erp-nav-group">
            <div class="erp-nav-group-title">${esc(g.group)}</div>
            ${items.map((i) => `
              <a class="erp-nav-item" data-section="${i.id}" href="#${i.id}">
                <span class="ic">${i.icon}</span><span class="lbl">${esc(i.label)}</span>
              </a>`).join('')}
          </div>`;
        }).join('')}
      </nav>
      <div class="erp-sidebar-foot">Development build · shares Supabase only</div>
    </aside>`;
}

export function wireSidebar(root, onNavigate) {
  root.querySelectorAll('.erp-nav-item').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); onNavigate(a.dataset.section); }));
  return {
    setActive(section) {
      root.querySelectorAll('.erp-nav-item').forEach((a) =>
        a.classList.toggle('active', a.dataset.section === section));
    },
  };
}

export { labelOf };
