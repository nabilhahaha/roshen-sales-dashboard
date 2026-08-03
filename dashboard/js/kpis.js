/* ============================================================================
 * kpis.js — render the 10 KPI cards from an aggregation result.
 * Exposed as the global `KPIs`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const U = global.Utils;

  // Card definitions: id, label, icon, tone, and a value accessor + formatter.
  const CARDS = [
    { id: 'totalSales',       label: 'Total Sales',      icon: 'fa-sack-dollar', tone: 'primary',
      value: (k) => k.totalSales, fmt: (v) => U.moneyShort(v), sub: (k, a) => `${U.num(a.totals.lines)} lines` },
    { id: 'totalCustomers',   label: 'Total Customers',  icon: 'fa-users', tone: 'info',
      value: (k) => k.totalCustomers, fmt: (v) => U.num(v), sub: (k) => `${U.num(k.activeCustomers)} active` },
    { id: 'activeCustomers',  label: 'Active Customers', icon: 'fa-user-check', tone: 'success',
      value: (k) => k.activeCustomers, fmt: (v) => U.num(v),
      sub: (k) => k.totalCustomers ? U.pct((k.activeCustomers / k.totalCustomers) * 100) + ' of base' : '—' },
    { id: 'inactiveCustomers',label: 'Inactive Customers', icon: 'fa-user-clock', tone: 'warning',
      value: (k) => k.inactiveCustomers, fmt: (v) => U.num(v),
      sub: (k) => k.totalCustomers ? U.pct((k.inactiveCustomers / k.totalCustomers) * 100) + ' of base' : '—' },
    { id: 'totalOrders',      label: 'Total Orders',     icon: 'fa-file-invoice', tone: 'info',
      value: (k) => k.totalOrders, fmt: (v) => U.num(v), sub: (k) => `${U.num(k.totalQty)} pcs` },
    { id: 'avgOrderValue',    label: 'Avg Order Value',  icon: 'fa-receipt', tone: 'primary',
      value: (k) => k.avgOrderValue, fmt: (v) => U.money(v), sub: () => 'per invoice' },
    { id: 'achievementPct',   label: 'Achievement',      icon: 'fa-bullseye', tone: 'success',
      value: (k) => k.achievementPct, fmt: (v) => v == null ? '—' : U.pct(v),
      sub: (k) => `Target ${U.moneyShort(k.target)}`, progress: (k) => k.achievementPct },
    { id: 'growthPct',        label: 'Growth (MoM)',     icon: 'fa-arrow-trend-up', tone: 'info',
      value: (k) => k.growthPct, fmt: (v) => v == null ? '—' : (v >= 0 ? '+' : '') + U.pct(v),
      sub: () => 'vs previous month', signed: true },
    { id: 'collection',       label: 'Collection',       icon: 'fa-hand-holding-dollar', tone: 'success',
      value: (k) => k.collection, fmt: (v) => U.moneyShort(v), sub: () => 'incl. VAT (est.)' },
    { id: 'outstanding',      label: 'Outstanding',      icon: 'fa-scale-unbalanced', tone: 'warning',
      value: (k) => k.outstanding, fmt: (v) => U.moneyShort(v), sub: () => 'to be collected (est.)' },
  ];

  const KPIs = {
    /** Build the empty card shells once. */
    mount(container) {
      container.innerHTML = '';
      CARDS.forEach((c) => {
        const card = U.h('div', { class: `kpi-card kpi-${c.tone}`, 'data-kpi': c.id });
        card.innerHTML = `
          <div class="kpi-icon"><i class="fa-solid ${c.icon}"></i></div>
          <div class="kpi-body">
            <div class="kpi-label">${c.label}</div>
            <div class="kpi-value" id="kpi-${c.id}">—</div>
            <div class="kpi-sub" id="kpi-sub-${c.id}"></div>
            ${c.progress ? `<div class="kpi-progress"><span id="kpi-bar-${c.id}"></span></div>` : ''}
          </div>`;
        container.appendChild(card);
      });
    },

    /** Update card values from an aggregation result. */
    update(agg) {
      const k = agg.kpi;
      CARDS.forEach((c) => {
        const v = c.value(k);
        const valEl = U.el(`kpi-${c.id}`);
        const subEl = U.el(`kpi-sub-${c.id}`);
        if (valEl) valEl.textContent = c.fmt(v);
        if (subEl) subEl.textContent = c.sub ? c.sub(k, agg) : '';

        if (c.signed && valEl) {
          valEl.classList.toggle('trend-up', v != null && v >= 0);
          valEl.classList.toggle('trend-down', v != null && v < 0);
        }
        if (c.progress) {
          const bar = U.el(`kpi-bar-${c.id}`);
          const pct = Math.max(0, Math.min(100, c.progress(k) || 0));
          if (bar) bar.style.width = pct + '%';
        }
      });
    },
  };

  global.KPIs = KPIs;
})(window);
