/* ============================================================================
 * tables.js — 6 DataTables (sort, search, paginate, export CSV/Excel/PDF).
 * ----------------------------------------------------------------------------
 * Each table is created once with a column spec, then fed new data with
 * clear()/rows.add()/draw() on every filter change. `deferRender` + client
 * pagination keeps thousands of aggregated rows smooth.
 *
 * Exposed as the global `Tables`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const U = global.Utils;
  const $ = global.jQuery;

  const money = (v) => U.money(v);
  const int = (v) => U.num(v);

  // Column render helpers that keep numeric sorting correct while showing text.
  const numCol = (fmt) => ({ render: (data, type) => (type === 'display' ? fmt(data) : data) });

  const badge = (status) =>
    `<span class="badge-status ${status === 'Active' ? 'is-active' : 'is-inactive'}">${status}</span>`;

  /* ---- table definitions --------------------------------------------- */
  const DEFS = {
    customerList: {
      title: 'Customer List',
      columns: [
        { title: 'Customer', data: 'name' },
        { title: 'Region', data: 'region' },
        { title: 'City', data: 'city' },
        { title: 'Channel', data: 'channel' },
        { title: 'Salesman', data: 'salesman' },
        { title: 'Orders', data: 'ordersCount', className: 'text-end', ...numCol(int) },
        { title: 'Qty', data: 'qty', className: 'text-end', ...numCol(int) },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
        { title: 'Avg Order', data: 'avgOrder', className: 'text-end', ...numCol(money) },
        { title: 'Last Order', data: 'lastDate' },
        { title: 'Status', data: 'status', render: (d, t) => (t === 'display' ? badge(d) : d) },
      ],
      rows: (agg) => agg.lists.customers,
      order: [[7, 'desc']],
    },

    inactiveCustomers: {
      title: 'Inactive Customers',
      columns: [
        { title: 'Customer', data: 'name' },
        { title: 'Region', data: 'region' },
        { title: 'City', data: 'city' },
        { title: 'Salesman', data: 'salesman' },
        { title: 'Orders', data: 'ordersCount', className: 'text-end', ...numCol(int) },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
        { title: 'Last Order', data: 'lastDate' },
      ],
      rows: (agg) => agg.lists.customers.filter((c) => c.status === 'Inactive'),
      order: [[6, 'asc']],
    },

    topCustomers: {
      title: 'Top Customers',
      columns: [
        { title: '#', data: 'rank', className: 'text-end' },
        { title: 'Customer', data: 'name' },
        { title: 'Region', data: 'region' },
        { title: 'Channel', data: 'channel' },
        { title: 'Orders', data: 'ordersCount', className: 'text-end', ...numCol(int) },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
        { title: '% of Total', data: 'share', className: 'text-end', ...numCol((v) => U.pct(v)) },
      ],
      rows: (agg) => {
        const total = agg.kpi.totalSales || 1;
        return agg.lists.customers.slice(0, 50).map((c, i) => ({
          ...c, rank: i + 1, share: (c.sales / total) * 100,
        }));
      },
      order: [[0, 'asc']],
    },

    productSales: {
      title: 'Product Sales',
      columns: [
        { title: 'Product', data: 'name' },
        { title: 'Category', data: 'category' },
        { title: 'Sub-Category', data: 'subCategory' },
        { title: 'Qty (pcs)', data: 'qty', className: 'text-end', ...numCol(int) },
        { title: 'Orders', data: 'ordersCount', className: 'text-end', ...numCol(int) },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
      ],
      rows: (agg) => agg.lists.products,
      order: [[5, 'desc']],
    },

    salesmanPerformance: {
      title: 'Salesman Performance',
      columns: [
        { title: 'Salesman', data: 'key' },
        { title: 'Supervisor', data: 'supervisor' },
        { title: 'Customers', data: 'customerCount', className: 'text-end', ...numCol(int) },
        { title: 'Orders', data: 'ordersCount', className: 'text-end', ...numCol(int) },
        { title: 'Avg Order', data: 'avgOrder', className: 'text-end', ...numCol(money) },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
      ],
      rows: (agg) => agg.lists.salesmen,
      order: [[5, 'desc']],
    },

    routePerformance: {
      title: 'Route Performance',
      columns: [
        { title: 'Route (Territory)', data: 'key' },
        { title: 'Net Sales', data: 'sales', className: 'text-end', ...numCol(money) },
        { title: '% of Total', data: 'share', className: 'text-end', ...numCol((v) => U.pct(v)) },
      ],
      rows: (agg) => {
        const total = agg.kpi.totalSales || 1;
        return agg.lists.routes.map((r) => ({ ...r, share: (r.sales / total) * 100 }));
      },
      order: [[1, 'desc']],
    },
  };

  const tables = {}; // id -> DataTable API

  function buttonsFor(title) {
    const name = `${CFG.app.name.replace(/\s+/g, '_')}_${title.replace(/\s+/g, '_')}_${U.stamp()}`;
    return [
      { extend: 'copyHtml5', text: '<i class="fa-solid fa-copy"></i>', titleAttr: 'Copy', className: 'btn btn-sm' },
      { extend: 'csvHtml5', text: '<i class="fa-solid fa-file-csv"></i> CSV', className: 'btn btn-sm', title: name },
      { extend: 'excelHtml5', text: '<i class="fa-solid fa-file-excel"></i> Excel', className: 'btn btn-sm', title: name },
      { extend: 'pdfHtml5', text: '<i class="fa-solid fa-file-pdf"></i> PDF', className: 'btn btn-sm',
        title: name, orientation: 'landscape', pageSize: 'A4',
        customize: (doc) => { doc.defaultStyle.fontSize = 8; doc.styles.tableHeader.fontSize = 9; } },
      { extend: 'print', text: '<i class="fa-solid fa-print"></i>', titleAttr: 'Print', className: 'btn btn-sm', title: name },
    ];
  }

  const Tables = {
    /** Create all tables once against their (initially empty) <table> nodes. */
    init(agg) {
      Object.entries(DEFS).forEach(([id, def]) => {
        const sel = '#tbl-' + id;
        if (!$(sel).length) return;
        tables[id] = $(sel).DataTable({
          data: def.rows(agg),
          columns: def.columns,
          order: def.order,
          deferRender: true,
          pageLength: 10,
          lengthMenu: [[10, 25, 50, 100, -1], [10, 25, 50, 100, 'All']],
          responsive: true,
          autoWidth: false,
          dom: "<'dt-toolbar d-flex flex-wrap gap-2 justify-content-between align-items-center'<'dt-search'f><'dt-buttons-wrap'B>>rt<'dt-footer d-flex flex-wrap justify-content-between align-items-center'ip>",
          buttons: buttonsFor(def.title),
          language: {
            search: '', searchPlaceholder: 'Search…',
            lengthMenu: 'Show _MENU_', info: '_START_–_END_ of _TOTAL_',
            paginate: { previous: '‹', next: '›' },
          },
        });
      });
    },

    update(agg) {
      Object.entries(DEFS).forEach(([id, def]) => {
        const dt = tables[id];
        if (!dt) return;
        dt.clear();
        dt.rows.add(def.rows(agg));
        dt.draw(false);
      });
    },

    /** Recalculate column widths (call when a hidden table becomes visible). */
    adjust() {
      Object.values(tables).forEach((dt) => { try { dt.columns.adjust(); } catch (e) {} });
    },
  };

  global.Tables = Tables;
})(window);
