/* ============================================================================
 * filters.js — build the global filter bar and wire it to the data store.
 * ----------------------------------------------------------------------------
 * Filters are data-driven from DASHBOARD_CONFIG.filters. A filter is only
 * rendered if its dimension actually has values in the current file, so the
 * bar adapts automatically to whatever the workbook contains.
 *
 * Any change calls the `onChange` callback (app re-aggregates + re-renders).
 * Exposed as the global `Filters`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const U = global.Utils;
  const DS = global.DataStore;

  let onChange = () => {};

  function option(value, label) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    return o;
  }

  /** "Branch" -> "Branches", "Category" -> "Categories", "Salesman" -> "Salesmen". */
  function plural(word) {
    if (/man$/i.test(word)) return word.replace(/man$/i, 'men');
    if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
    if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
    return word + 's';
  }

  const Filters = {
    /** Render selects + date range into `container`. */
    build(container, changeCb) {
      onChange = changeCb || onChange;
      container.innerHTML = '';

      // ---- Date range (from / to) ----
      const meta = DS.meta;
      const dateWrap = U.h('div', { class: 'filter-item filter-date' });
      dateWrap.innerHTML = `
        <label><i class="fa-solid fa-calendar-day"></i> Date Range</label>
        <div class="d-flex gap-1">
          <input type="date" class="form-control form-control-sm" id="f-date-from"
            min="${meta.minDate ? U.ymd(meta.minDate) : ''}" max="${meta.maxDate ? U.ymd(meta.maxDate) : ''}">
          <input type="date" class="form-control form-control-sm" id="f-date-to"
            min="${meta.minDate ? U.ymd(meta.minDate) : ''}" max="${meta.maxDate ? U.ymd(meta.maxDate) : ''}">
        </div>`;
      container.appendChild(dateWrap);

      // ---- Dimension selects ----
      (CFG.filters || []).forEach((f) => {
        if (f.enabled === false) return;
        const values = DS.dimensions[f.field] || [];
        if (!values.length) return; // hide filters with no data

        const item = U.h('div', { class: 'filter-item' });
        const sel = U.h('select', { class: 'form-select form-select-sm', id: 'f-' + f.field, 'data-field': f.field });
        sel.appendChild(option('', 'All ' + plural(f.label)));
        values.forEach((v) => {
          const label = f.field === 'month' ? U.monthLabel(v) : v;
          sel.appendChild(option(v, label));
        });
        item.innerHTML = `<label><i class="fa-solid ${f.icon}"></i> ${f.label}</label>`;
        item.appendChild(sel);
        container.appendChild(item);
      });

      this._wire(container);
    },

    _wire(container) {
      const fire = U.debounce(() => onChange(), 120);

      U.qsa('select[data-field]', container).forEach((sel) => {
        sel.addEventListener('change', () => {
          DS.setFilter(sel.dataset.field, sel.value);
          fire();
        });
      });

      const from = U.el('f-date-from');
      const to = U.el('f-date-to');
      const applyDates = () => { DS.setDateRange(from.value, to.value); fire(); };
      from.addEventListener('change', applyDates);
      to.addEventListener('change', applyDates);
    },

    /** Clear every filter and refresh. */
    reset(container) {
      U.qsa('select[data-field]', container).forEach((s) => (s.value = ''));
      const from = U.el('f-date-from'); const to = U.el('f-date-to');
      if (from) from.value = ''; if (to) to.value = '';
      DS.resetFilters();
      onChange();
    },

    /** Human-readable summary of active filters (for the header + PDF). */
    summary() {
      const f = DS.filters;
      const parts = [];
      (CFG.filters || []).forEach((cf) => {
        if (f[cf.field] != null) {
          const val = cf.field === 'month' ? U.monthLabel(f[cf.field]) : f[cf.field];
          parts.push(`${cf.label}: ${val}`);
        }
      });
      if (f.dateFrom || f.dateTo) {
        parts.push(`Date: ${f.dateFrom ? U.ymd(f.dateFrom) : '…'} → ${f.dateTo ? U.ymd(f.dateTo) : '…'}`);
      }
      return parts.length ? parts.join('  •  ') : 'All data';
    },
  };

  global.Filters = Filters;
})(window);
