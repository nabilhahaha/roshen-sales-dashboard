/* ============================================================================
 * charts.js — all 14 ApexCharts. Create-once, then update on filter changes.
 * ----------------------------------------------------------------------------
 * Pattern: `Charts.renderAll(agg)` creates each chart the first time and calls
 * `updateSeries`/`updateOptions` afterwards (much faster than destroy+rebuild).
 * `Charts.applyTheme()` re-tints every chart when dark/light mode toggles.
 *
 * Exposed as the global `Charts`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const U = global.Utils;
  const PALETTE = CFG.palette.series;

  const instances = {};   // id -> ApexCharts instance
  let lastAgg = null;

  /* ---- theme-aware defaults ------------------------------------------- */
  function themeColors() {
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      dark,
      fg: dark ? '#C7D0E0' : '#3A4256',
      muted: dark ? '#8791A7' : '#6B7280',
      grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(17,24,39,0.07)',
      mode: dark ? 'dark' : 'light',
    };
  }

  function baseOptions() {
    const t = themeColors();
    return {
      chart: {
        fontFamily: 'inherit',
        foreColor: t.fg,
        toolbar: { show: false },
        animations: { enabled: true, easing: 'easeinout', speed: 500 },
        background: 'transparent',
      },
      theme: { mode: t.mode },
      grid: { borderColor: t.grid, strokeDashArray: 4, padding: { left: 8, right: 8 } },
      dataLabels: { enabled: false },
      tooltip: { theme: t.mode },
      colors: PALETTE,
      noData: { text: 'No data for the current filters', style: { color: t.muted } },
    };
  }

  const moneyFmt = (v) => U.moneyShort(v);
  const moneyAxis = { labels: { formatter: moneyFmt } };

  /* ---- create-or-update helper ---------------------------------------- */
  function draw(id, options) {
    const elId = 'chart-' + id;
    const node = document.getElementById(elId);
    if (!node) return;
    if (instances[id]) {
      instances[id].updateOptions(options, false, true, false);
    } else {
      instances[id] = new ApexCharts(node, options);
      instances[id].render();
    }
  }

  /* ---- individual chart builders -------------------------------------- */
  function labelsAndData(list, n) {
    const arr = n ? list.slice(0, n) : list;
    return { labels: arr.map((x) => x.key), data: arr.map((x) => Math.round(x.sales)) };
  }

  const build = {
    salesTrend(agg) {
      const s = agg.series.monthSeries;
      draw('salesTrend', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'area', height: 300 }),
        series: [{ name: 'Net Sales', data: s.map((m) => Math.round(m.sales)) }],
        xaxis: { categories: s.map((m) => U.monthLabel(m.key)) },
        yaxis: moneyAxis,
        stroke: { curve: 'smooth', width: 3 },
        fill: { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: 0.4, opacityTo: 0.05 } },
        colors: [CFG.palette.primary],
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },

    monthlySales(agg) {
      const s = agg.series.monthSeries;
      draw('monthlySales', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'bar', height: 300 }),
        series: [{ name: 'Net Sales', data: s.map((m) => Math.round(m.sales)) }],
        xaxis: { categories: s.map((m) => U.monthLabel(m.key)) },
        yaxis: moneyAxis,
        plotOptions: { bar: { borderRadius: 4, columnWidth: '55%' } },
        colors: [CFG.palette.secondary],
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },

    dailySales(agg) {
      const s = agg.series.daySeries;
      draw('dailySales', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'area', height: 300 }),
        series: [{ name: 'Net Sales', data: s.map((d) => ({ x: d.key, y: Math.round(d.sales) })) }],
        xaxis: { type: 'datetime' },
        yaxis: moneyAxis,
        stroke: { curve: 'smooth', width: 2 },
        fill: { type: 'gradient', gradient: { opacityFrom: 0.3, opacityTo: 0 } },
        colors: ['#2E86DE'],
        tooltip: { theme: themeColors().mode, x: { format: 'dd MMM yyyy' }, y: { formatter: U.money } },
      }));
    },

    _hbar(id, list, n, color) {
      const { labels, data } = labelsAndData(list, n);
      draw(id, Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'bar', height: 320 }),
        series: [{ name: 'Net Sales', data }],
        xaxis: Object.assign({ categories: labels }, moneyAxis),
        plotOptions: { bar: { horizontal: true, borderRadius: 4, barHeight: '70%' } },
        colors: [color],
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },
    _vbar(id, list, n, color) {
      const { labels, data } = labelsAndData(list, n);
      draw(id, Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'bar', height: 320 }),
        series: [{ name: 'Net Sales', data }],
        xaxis: { categories: labels, labels: { rotate: -35, trim: true, hideOverlappingLabels: true } },
        yaxis: moneyAxis,
        plotOptions: { bar: { borderRadius: 4, columnWidth: '60%' } },
        colors: [color],
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },

    salesByRegion(agg)     { build._hbar('salesByRegion', sortDesc(agg.byRegion), null, '#E4002B'); },
    salesByCity(agg)       { build._hbar('salesByCity', sortDesc(agg.byCity), CFG.charts.topCities, '#2E86DE'); },
    salesBySupervisor(agg) { build._hbar('salesBySupervisor', sortDesc(agg.bySupervisor), null, '#7A2E8E'); },
    salesBySalesman(agg)   { build._vbar('salesBySalesman', agg.lists.salesmen, CFG.charts.topSalesmen, '#16A085'); },

    _donut(id, list, n) {
      const arr = n ? list.slice(0, n) : list;
      draw(id, Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'donut', height: 320 }),
        series: arr.map((x) => Math.round(Math.max(0, x.sales))),
        labels: arr.map((x) => x.key),
        legend: { position: 'bottom' },
        plotOptions: { pie: { donut: { size: '62%', labels: { show: true,
          total: { show: true, label: 'Total', formatter: () => U.moneyShort(arr.reduce((t, x) => t + Math.max(0, x.sales), 0)) } } } } },
        dataLabels: { enabled: true, formatter: (val) => val.toFixed(0) + '%' },
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },
    salesByChannel(agg)  { build._donut('salesByChannel', sortDesc(agg.byChannel)); },
    salesByCategory(agg) { build._donut('salesByCategory', sortDesc(agg.byCategory)); },

    topCustomers(agg) {
      build._hbar('topCustomers', agg.lists.customers.map((c) => ({ key: c.name, sales: c.sales })),
        CFG.charts.topCustomers, '#E67E22');
    },

    pareto(agg) {
      const p = agg.series.pareto;
      draw('pareto', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'line', height: 340, stacked: false }),
        series: [
          { name: 'Net Sales', type: 'column', data: p.map((x) => Math.round(Math.max(0, x.sales))) },
          { name: 'Cumulative %', type: 'line', data: p.map((x) => +x.cumPct.toFixed(1)) },
        ],
        xaxis: { categories: p.map((x) => x.key), labels: { rotate: -40, trim: true, maxHeight: 90 } },
        yaxis: [
          Object.assign({ seriesName: 'Net Sales' }, moneyAxis),
          { opposite: true, max: 100, min: 0, seriesName: 'Cumulative %', labels: { formatter: (v) => v.toFixed(0) + '%' } },
        ],
        stroke: { width: [0, 3] },
        plotOptions: { bar: { borderRadius: 3, columnWidth: '55%' } },
        markers: { size: [0, 4] },
        colors: ['#7A2E8E', '#E4002B'],
        tooltip: { theme: themeColors().mode },
      }));
    },

    targetVsAchievement(agg) {
      const t = agg.series.targetVsAch;
      draw('targetVsAchievement', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'line', height: 320 }),
        series: [
          { name: 'Actual', type: 'column', data: t.map((m) => Math.round(m.actual)) },
          { name: 'Target', type: 'line', data: t.map((m) => Math.round(m.target)) },
        ],
        xaxis: { categories: t.map((m) => U.monthLabel(m.key)) },
        yaxis: moneyAxis,
        stroke: { width: [0, 3], dashArray: [0, 5] },
        plotOptions: { bar: { borderRadius: 4, columnWidth: '55%' } },
        colors: ['#16A085', '#E4002B'],
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },

    customerStatus(agg) {
      const k = agg.kpi;
      draw('customerStatus', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'donut', height: 300 }),
        series: [k.activeCustomers, k.inactiveCustomers],
        labels: ['Active', 'Inactive'],
        colors: ['#27AE60', '#E67E22'],
        legend: { position: 'bottom' },
        plotOptions: { pie: { donut: { size: '65%', labels: { show: true,
          total: { show: true, label: 'Customers', formatter: () => U.num(k.totalCustomers) } } } } },
        tooltip: { theme: themeColors().mode },
      }));
    },

    productMix(agg) {
      const arr = sortDesc(agg.bySubCategory);
      draw('productMix', Object.assign(baseOptions(), {
        chart: Object.assign(baseOptions().chart, { type: 'treemap', height: 320 }),
        series: [{ data: arr.map((x) => ({ x: x.key, y: Math.round(Math.max(0, x.sales)) })) }],
        legend: { show: false },
        colors: PALETTE,
        plotOptions: { treemap: { distributed: true, enableShades: false } },
        dataLabels: { enabled: true, style: { fontSize: '12px' }, formatter: (t, op) =>
          [t, U.moneyShort(op.value)] },
        tooltip: { theme: themeColors().mode, y: { formatter: U.money } },
      }));
    },
  };

  function sortDesc(map) {
    return Array.from(map.values()).sort((a, b) => b.sales - a.sales);
  }

  const ORDER = [
    'salesTrend', 'monthlySales', 'dailySales', 'salesByRegion', 'salesByCity',
    'salesBySupervisor', 'salesBySalesman', 'salesByChannel', 'salesByCategory',
    'topCustomers', 'pareto', 'targetVsAchievement', 'customerStatus', 'productMix',
  ];

  const Charts = {
    renderAll(agg) {
      lastAgg = agg;
      // Build sequentially on idle to keep the UI responsive.
      ORDER.forEach((id) => {
        if (typeof build[id] === 'function') build[id](agg);
      });
    },

    applyTheme() {
      if (lastAgg) this.renderAll(lastAgg);
    },

    /** ApexCharts sometimes needs a nudge when a hidden tab becomes visible. */
    reflow() {
      Object.values(instances).forEach((c) => { try { c.render(); } catch (e) { /* noop */ } });
    },

    destroyAll() {
      Object.values(instances).forEach((c) => { try { c.destroy(); } catch (e) {} });
      Object.keys(instances).forEach((k) => delete instances[k]);
    },
  };

  global.Charts = Charts;
})(window);
