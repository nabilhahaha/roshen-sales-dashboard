// Top bar — company / breadcrumb, global search, notifications, dev user.
export function topbarHtml() {
  return `
    <header class="erp-topbar">
      <div class="erp-crumb"><span class="erp-crumb-co">Roshen / Relia</span> <span class="sep">/</span> <b data-el="title">Dashboard</b></div>
      <div class="erp-search"><span>🔎</span><input data-el="search" placeholder="Search SKUs, orders…" autocomplete="off"></div>
      <div class="erp-topbar-right">
        <button class="erp-iconbtn" data-el="notif" title="Pending validations">🔔<span class="erp-badge" data-el="notifCount" style="display:none"></span></button>
        <div class="erp-user"><span class="erp-user-avatar">🧑‍💻</span><div class="erp-user-text"><b>Development</b><span>No auth</span></div></div>
      </div>
    </header>`;
}

export function wireTopbar(root, { onSearch, onNotif }) {
  const search = root.querySelector('[data-el="search"]');
  if (search) search.addEventListener('input', (e) => onSearch(e.target.value));
  const notif = root.querySelector('[data-el="notif"]');
  if (notif) notif.addEventListener('click', () => onNotif && onNotif());
  return {
    setTitle(text) { const t = root.querySelector('[data-el="title"]'); if (t) t.textContent = text; },
    setNotif(count) {
      const b = root.querySelector('[data-el="notifCount"]');
      if (!b) return;
      if (count > 0) { b.textContent = count; b.style.display = 'flex'; } else { b.style.display = 'none'; }
    },
  };
}
