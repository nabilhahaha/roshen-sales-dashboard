// Top bar — company / breadcrumb, global search, theme switch, notifications.
import { getTheme, toggleTheme } from '../../utils/theme.js';
import { LOCALES, getLocale, setLocale } from '../../i18n/i18n.js';

const themeIcon = (t) => (t === 'light' ? '🌙' : '☀️');
const themeTitle = (t) => (t === 'light' ? 'Switch to dark mode' : 'Switch to light mode');

export function topbarHtml() {
  const t = getTheme();
  return `
    <header class="erp-topbar">
      <button class="erp-iconbtn erp-burger" data-el="burger" title="Menu" aria-label="Open navigation">☰</button>
      <div class="erp-crumb"><span class="erp-crumb-co">Roshen / Relia</span> <span class="sep">/</span> <b data-el="title">Purchase Orders</b></div>
      <div class="erp-search"><span>🔎</span><input data-el="search" placeholder="Search SKUs, orders…" autocomplete="off"></div>
      <div class="erp-topbar-right">
        <span class="erp-lang" title="Language">🌐<select data-el="lang" aria-label="Language">
          ${Object.entries(LOCALES).map(([k, v]) => `<option value="${k}">${v.name}</option>`).join('')}
        </select></span>
        <button class="erp-iconbtn" data-el="theme" title="${themeTitle(t)}" aria-label="Toggle theme">${themeIcon(t)}</button>
        <button class="erp-iconbtn" data-el="notif" title="Pending validations">🔔<span class="erp-badge" data-el="notifCount" style="display:none"></span></button>
        <div class="erp-user-wrap" data-el="userWrap">
          <button class="erp-user" data-el="user" title="Account menu"><span class="erp-user-avatar">🧑‍💻</span><div class="erp-user-text"><b>Development</b><span>No auth</span></div></button>
          <div class="erp-user-menu" data-el="userMenu" style="display:none">
            <button class="erp-user-menu-item" data-el="settings">⚙️ Settings</button>
          </div>
        </div>
      </div>
    </header>`;
}

export function wireTopbar(root, { onSearch, onNotif, onSettings }) {
  // mobile navigation: the burger slides the sidebar in; the scrim closes it
  const burger = root.querySelector('[data-el="burger"]');
  if (burger) burger.addEventListener('click', (e) => {
    e.stopPropagation();
    const erp = root.querySelector('.erp');
    const on = erp.classList.toggle('nav-open');
    let scrim = erp.querySelector('.erp-scrim');
    if (on && !scrim) {
      scrim = document.createElement('div');
      scrim.className = 'erp-scrim';
      scrim.addEventListener('click', () => erp.classList.remove('nav-open'));
      erp.appendChild(scrim);
    }
  });
  const search = root.querySelector('[data-el="search"]');
  if (search) search.addEventListener('input', (e) => onSearch(e.target.value));
  const notif = root.querySelector('[data-el="notif"]');
  if (notif) notif.addEventListener('click', () => onNotif && onNotif());
  const lang = root.querySelector('[data-el="lang"]');
  if (lang) { lang.value = getLocale(); lang.addEventListener('change', () => setLocale(lang.value)); }
  const theme = root.querySelector('[data-el="theme"]');
  if (theme) theme.addEventListener('click', () => { const t = toggleTheme(); theme.textContent = themeIcon(t); theme.title = themeTitle(t); });
  const userBtn = root.querySelector('[data-el="user"]');
  const userMenu = root.querySelector('[data-el="userMenu"]');
  const closeMenu = () => { if (userMenu) userMenu.style.display = 'none'; };
  if (userBtn && userMenu) {
    userBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      userMenu.style.display = userMenu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', (e) => { if (!userMenu.contains(e.target)) closeMenu(); });
    const settings = root.querySelector('[data-el="settings"]');
    if (settings) settings.addEventListener('click', () => { closeMenu(); onSettings && onSettings(); });
  }
  return {
    setTitle(text) { const t = root.querySelector('[data-el="title"]'); if (t) t.textContent = text; },
    setNotif(count) {
      const b = root.querySelector('[data-el="notifCount"]');
      if (!b) return;
      if (count > 0) { b.textContent = count; b.style.display = 'flex'; } else { b.style.display = 'none'; }
    },
  };
}
