/* ============================================================================
 * aggregations.js — turn a set of records into every metric the UI needs.
 * ----------------------------------------------------------------------------
 * `Aggregations.compute(rows)` does ONE pass and returns a plain object that
 * KPIs, charts and tables all read from. Keeping it single-pass is what lets
 * the dashboard re-render instantly when a filter changes on large datasets.
 *
 * Exposed as the global `Aggregations`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;

  /** Get-or-create a map bucket. */
  function bucket(map, key) {
    let b = map.get(key);
    if (!b) { b = { key, sales: 0, qty: 0, orders: new Set() }; map.set(key, b); }
    return b;
  }

  /** Map<key,{sales,...}> -> sorted array [{key,sales,...}] desc by sales. */
  function toSorted(map, valueKey = 'sales') {
    const arr = Array.from(map.values());
    arr.sort((a, b) => b[valueKey] - a[valueKey]);
    return arr;
  }

  const Aggregations = {
    compute(rows) {
      const A = {
        totals: {
          netSales: 0, gross: 0, returns: 0, withVat: 0, discount: 0, qty: 0,
          lines: rows.length,
        },
        // dimension -> Map(key -> bucket)
        byMonth: new Map(),
        byDay: new Map(),
        byRegion: new Map(),
        byCity: new Map(),
        byChannel: new Map(),
        byCategory: new Map(),
        bySubCategory: new Map(),
        bySupervisor: new Map(),
        bySalesman: new Map(),
        byRoute: new Map(),      // proxy: branch
        perCustomer: new Map(),
        perProduct: new Map(),
        _orders: new Set(),
        _maxTs: 0,
      };

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const s = r.sales;

        A.totals.netSales += s;
        A.totals.gross += r.gross;
        A.totals.withVat += r.withVat;
        A.totals.discount += r.discount;
        A.totals.qty += r.qty;
        if (r.isReturn) A.totals.returns += s; // negative

        if (r.ts > A._maxTs) A._maxTs = r.ts;
        if (r.docId) A._orders.add(r.docId);

        // time series
        if (r.ym) bucket(A.byMonth, r.ym).sales += s;
        if (r.ymd) bucket(A.byDay, r.ymd).sales += s;

        // simple dimensions
        bucket(A.byRegion, r.region).sales += s;
        bucket(A.byCity, r.city).sales += s;
        bucket(A.byChannel, r.channel).sales += s;
        bucket(A.byCategory, r.category).sales += s;
        bucket(A.bySubCategory, r.subCategory).sales += s;
        bucket(A.byRoute, r.branch).sales += s;

        // supervisor (track customers + orders)
        const sup = bucket(A.bySupervisor, r.supervisor);
        sup.sales += s; if (r.docId) sup.orders.add(r.docId);

        // salesman (track customers + orders + supervisor)
        let sm = A.bySalesman.get(r.salesman);
        if (!sm) { sm = { key: r.salesman, sales: 0, orders: new Set(), customers: new Set(), supervisor: r.supervisor }; A.bySalesman.set(r.salesman, sm); }
        sm.sales += s; if (r.docId) sm.orders.add(r.docId);
        if (r.customerId) sm.customers.add(r.customerId);

        // per-customer
        const cid = r.customerId || r.customer;
        let c = A.perCustomer.get(cid);
        if (!c) {
          c = { id: cid, name: r.customer, sales: 0, qty: 0, orders: new Set(),
            region: r.region, city: r.city, channel: r.channel, salesman: r.salesman,
            lastTs: 0 };
          A.perCustomer.set(cid, c);
        }
        c.sales += s; c.qty += r.qty; if (r.docId) c.orders.add(r.docId);
        if (r.ts > c.lastTs) { c.lastTs = r.ts; c.lastDate = r.ymd; }

        // per-product
        const pid = r.itemId || r.product;
        let p = A.perProduct.get(pid);
        if (!p) { p = { id: pid, name: r.product, category: r.category, subCategory: r.subCategory, sales: 0, qty: 0, orders: new Set() }; A.perProduct.set(pid, p); }
        p.sales += s; p.qty += r.qty; if (r.docId) p.orders.add(r.docId);
      }

      return this._derive(A);
    },

    /** Second, cheap pass over the (small) grouped maps to derive KPIs. */
    _derive(A) {
      const k = CFG.kpis;
      const ordersCount = A._orders.size;

      // ---- Customers: active / inactive by recency window ----
      const cutoff = A._maxTs - k.activeWindowDays * 86400 * 1000;
      let active = 0, inactive = 0;
      const customers = [];
      A.perCustomer.forEach((c) => {
        c.ordersCount = c.orders.size;
        c.avgOrder = c.ordersCount ? c.sales / c.ordersCount : 0;
        c.status = (c.lastTs && c.lastTs >= cutoff) ? 'Active' : 'Inactive';
        if (c.status === 'Active') active++; else inactive++;
        customers.push(c);
      });
      customers.sort((a, b) => b.sales - a.sales);

      // ---- Products / salesmen collapse Sets to counts ----
      const products = [];
      A.perProduct.forEach((p) => { p.ordersCount = p.orders.size; products.push(p); });
      products.sort((a, b) => b.sales - a.sales);

      const salesmen = [];
      A.bySalesman.forEach((s) => {
        s.ordersCount = s.orders.size;
        s.customerCount = s.customers.size;
        s.avgOrder = s.ordersCount ? s.sales / s.ordersCount : 0;
        salesmen.push(s);
      });
      salesmen.sort((a, b) => b.sales - a.sales);

      const supervisors = toSorted(A.bySupervisor).map((s) => ({ ...s, ordersCount: s.orders.size }));

      // routes (territory proxy) — enrich with orders/customers from salesman roll-up not needed
      const routes = toSorted(A.byRoute);

      // ---- Month series & growth ----
      const months = Array.from(A.byMonth.keys()).sort();
      const monthSeries = months.map((m) => ({ key: m, sales: A.byMonth.get(m).sales }));
      let growthPct = null;
      if (monthSeries.length >= 2) {
        const last = monthSeries[monthSeries.length - 1].sales;
        const prev = monthSeries[monthSeries.length - 2].sales;
        growthPct = prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null;
      }

      const daySeries = Array.from(A.byDay.keys()).sort().map((d) => ({ key: d, sales: A.byDay.get(d).sales }));

      // ---- Achievement vs target ----
      const monthsInView = Math.max(1, months.length);
      const target = k.monthlyTargetSar * monthsInView;
      const achievementPct = target ? (A.totals.netSales / target) * 100 : null;

      // Per-month target vs achievement (for the chart).
      const targetVsAch = monthSeries.map((m) => ({
        key: m.key, actual: m.sales, target: k.monthlyTargetSar,
      }));

      // ---- Collection / Outstanding (derived — no AR data in file) ----
      const collection = A.totals.withVat * k.collectionRatePct;
      const outstanding = A.totals.withVat - collection;

      // ---- Pareto (top contributors + cumulative %) ----
      const paretoSource = CFG.charts.paretoOn === 'product' ? products : customers;
      const paretoTop = paretoSource.slice(0, 20).map((x) => ({ key: x.name, sales: x.sales }));
      const grand = paretoSource.reduce((t, x) => t + Math.max(0, x.sales), 0) || 1;
      let cum = 0;
      const pareto = paretoTop.map((x) => {
        cum += Math.max(0, x.sales);
        return { key: x.key, sales: x.sales, cumPct: (cum / grand) * 100 };
      });

      A.kpi = {
        totalSales: A.totals.netSales,
        totalCustomers: A.perCustomer.size,
        activeCustomers: active,
        inactiveCustomers: inactive,
        totalOrders: ordersCount,
        avgOrderValue: ordersCount ? A.totals.netSales / ordersCount : 0,
        achievementPct,
        growthPct,
        collection,
        outstanding,
        target,
        returns: A.totals.returns,
        totalQty: A.totals.qty,
      };
      A.lists = { customers, products, salesmen, supervisors, routes };
      A.series = { monthSeries, daySeries, targetVsAch, pareto };
      A.ordersCount = ordersCount;
      return A;
    },

    /** Convenience: top-N of a sorted array. */
    top(arr, n) { return arr.slice(0, n); },
  };

  global.Aggregations = Aggregations;
})(window);
