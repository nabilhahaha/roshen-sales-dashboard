/* ============================================================================
 * app.js — orchestration. Wires modules together and owns the refresh cycle.
 * ----------------------------------------------------------------------------
 * Flow:
 *   boot()                once, on DOMContentLoaded
 *   onDataLoaded()        after a workbook is parsed → first full render
 *   refresh()             on every filter change → recompute + update UI
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const U = global.Utils;
  const DS = global.DataStore;
  const Agg = global.Aggregations;

  let tablesReady = false;

  /** Recompute aggregates for the current filter set and update everything. */
  const refresh = U.debounce(function () {
    if (!DS.isLoaded()) return;
    const t0 = performance.now();
    const rows = DS.getFilteredRows();
    const agg = Agg.compute(rows);

    global.KPIs.update(agg);
    global.Charts.renderAll(agg);
    if (!tablesReady) { global.Tables.init(agg); tablesReady = true; }
    else global.Tables.update(agg);

    // Header context
    U.el('active-filter-summary').textContent = global.Filters.summary();
    U.el('row-count-badge').textContent = `${U.num(rows.length)} rows`;
    U.el('render-time').textContent = `${Math.round(performance.now() - t0)} ms`;
    global.Tables.adjust();
  }, 60);

  function onDataLoaded() {
    // Reveal the dashboard, hide the upload hero (keep a compact re-upload button).
    document.body.classList.add('data-loaded');
    U.el('upload-overlay').classList.add('hidden');

    // Header meta
    const m = DS.meta;
    U.el('dataset-file').textContent = m.fileName || '—';
    U.el('dataset-range').textContent = (m.minDate && m.maxDate)
      ? `${U.ymd(m.minDate)} → ${U.ymd(m.maxDate)}` : '—';
    U.el('dataset-rows').textContent = U.num(m.rowCount);

    // Build filters (data-driven) then do the first render.
    global.Filters.build(U.el('filter-bar'), refresh);
    tablesReady = false;
    refresh();
  }

  function wireNav() {
    // Sidebar section navigation (single-page scroll + active state).
    U.qsa('[data-section]').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const id = link.dataset.section;
        const target = U.el(id);
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        U.qsa('[data-section]').forEach((l) => l.classList.remove('active'));
        link.classList.add('active');
        // On mobile, collapse the sidebar after choosing.
        document.body.classList.remove('sidebar-open');
      });
    });

    // Sidebar toggle (mobile)
    const burger = U.el('btn-sidebar');
    if (burger) burger.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
    const backdrop = U.el('sidebar-backdrop');
    if (backdrop) backdrop.addEventListener('click', () => document.body.classList.remove('sidebar-open'));

    // Reset filters
    const reset = U.el('btn-reset-filters');
    if (reset) reset.addEventListener('click', () => global.Filters.reset(U.el('filter-bar')));

    // Re-upload from the topbar
    const reup = U.el('btn-reupload');
    if (reup) reup.addEventListener('click', () => {
      U.el('upload-overlay').classList.remove('hidden');
    });
    const closeUpload = U.el('btn-close-upload');
    if (closeUpload) closeUpload.addEventListener('click', () => {
      if (DS.isLoaded()) U.el('upload-overlay').classList.add('hidden');
    });

    // Scroll-spy: highlight the section currently in view.
    const sections = U.qsa('.dash-section');
    if ('IntersectionObserver' in global && sections.length) {
      const obs = new IntersectionObserver((entries) => {
        entries.forEach((en) => {
          if (en.isIntersecting) {
            U.qsa('[data-section]').forEach((l) =>
              l.classList.toggle('active', l.dataset.section === en.target.id));
          }
        });
      }, { rootMargin: '-45% 0px -50% 0px' });
      sections.forEach((s) => obs.observe(s));
    }
  }

  function boot() {
    // Stamp brand text from config.
    U.el('brand-name').textContent = CFG.app.name;
    U.el('brand-sub').textContent = CFG.app.subtitle;
    U.qsa('[data-year]').forEach((n) => (n.textContent = new Date().getFullYear()));

    global.KPIs.mount(U.el('kpi-row'));

    global.Theme.init(() => global.Charts.applyTheme());
    global.Upload.init(onDataLoaded);
    wireNav();

    // Re-tint / reflow charts when returning to the tab or resizing.
    global.addEventListener('resize', U.debounce(() => global.Charts.reflow(), 250));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  global.App = { refresh };
})(window);
