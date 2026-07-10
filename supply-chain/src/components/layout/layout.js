// ERP shell — composes sidebar + topbar and exposes the content mount point.
// Purpose-built for Supply Chain; does not reuse the Sales Dashboard layout.
import { sidebarHtml, wireSidebar } from '../sidebar/sidebar.js';
import { topbarHtml, wireTopbar } from '../topbar/topbar.js';
import { labelOf } from '../../models/navigation.js';

export function renderShell(root, { onNavigate, onSearch }) {
  root.innerHTML = `
    <div class="erp">
      ${sidebarHtml()}
      <div class="erp-main">
        ${topbarHtml()}
        <main class="erp-content" id="erp-content"></main>
      </div>
    </div>`;

  const sidebar = wireSidebar(root, onNavigate);
  const topbar = wireTopbar(root, { onSearch, onNotif: () => onNavigate('validation'), onSettings: () => onNavigate('settings') });

  return {
    content: root.querySelector('#erp-content'),
    setActive(section) { sidebar.setActive(section); topbar.setTitle(labelOf(section)); },
    setNotif(count) { topbar.setNotif(count); },
  };
}
