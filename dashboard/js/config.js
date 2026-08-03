/* ============================================================================
 * config.js — Excel column mapping & dashboard configuration
 * ----------------------------------------------------------------------------
 * This is the SINGLE SOURCE OF TRUTH for how the raw Excel columns map to the
 * logical fields the dashboard understands. When your Excel headers change,
 * you only edit this file — no other code needs to change.
 *
 * The uploaded workbook is expected to keep the SAME structure every day:
 * one sheet of transaction-level (invoice line) sales rows.
 *
 * Exposed as the global `DASHBOARD_CONFIG`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CONFIG = {
    /* ---- App identity ---------------------------------------------------- */
    app: {
      name: 'Roshen KSA',
      subtitle: 'Sales Performance Dashboard',
      currency: 'SAR',
      // Intl locale used for number / currency / date formatting.
      locale: 'en-US',
      // If a sheet name is given the parser will prefer it; otherwise the
      // first sheet in the workbook is used (robust to sheet renames).
      preferredSheet: null,
    },

    /* ---- Column mapping --------------------------------------------------
     * key   = logical field used throughout the app
     * value = exact Excel header text (case/space-insensitive match — see
     *         dataStore.normalizeHeader). Provide an array to accept aliases;
     *         the first header that exists in the file wins.
     * -------------------------------------------------------------------- */
    columns: {
      // ---- Measures (numeric) ----
      netAmount:        'Net Amount Excl Vat',            // net of returns (returns are negative)
      grossSales:       'Gross Sales Excl Vat Sar',
      totalWithVat:     'Total With Vat Sar',
      totalWithDiscount:'Total With Discount Before Vat Sar',
      invoicePricePc:   'Invoice Price Per Pc Sar',
      discountAmount:   'Discount Amount',
      docDiscount:      'Doc Discount Amount',
      itemDiscount:     'Item Discount Amount',
      vatRate:          'Vat Rate',
      basicPricePc:     'Basic Price Per Pc Sar',
      freeQtyPcs:       'Free Quantity Pcs',
      qtyPcs:           'Quantity Pcs',
      freeQtyBox:       'Free Quantity Box',
      qtyBox:           'Quantity Box',
      cartonConfig:     'Item Carton Config',

      // ---- Product dimensions ----
      productName:      'Product Name',
      itemId:           'Item Id',
      referenceNo:      'Reference No',
      subCategory:      'Sub Per The Catalog',            // used as "Brand / Sub-Category"
      category:         'Per The Catalog',

      // ---- Geography / org dimensions ----
      city:             'City Name En',
      branch:           'Branch Name',
      customerName:     'Customer Name',
      customerId:       'Customer Id',
      channel:          'Channel Name',
      supervisorName:   'Sprv Name En',
      supervisorNo:     'Sprv No',
      salesmanName:     'Sr Name En',
      salesmanNo:       'Sr No',

      // ---- Document dimensions ----
      docDate:          'Doc Date',
      docId:            'Doc Id',
      docType:          'Doc Type',
    },

    /* ---- Which measure represents "sales value" -------------------------- */
    // All KPIs/charts sum this field. Net Amount already nets out returns.
    salesMeasure: 'netAmount',

    /* ---- Value normalisation --------------------------------------------
     * Raw data is messy (typos, casing). These rules clean dimension values
     * so groupings and filters don't fragment (e.g. "Damam" -> "Dammam").
     * -------------------------------------------------------------------- */
    normalize: {
      // Placeholder shown when a dimension value is blank/null.
      blankLabel: '(Unspecified)',

      // Exact-match replacements applied per field (after trimming).
      replacements: {
        city: {
          'Damam': 'Dammam',
          'Khubar': 'Khobar',
          'Al Ahsa': 'Al-Ahsa',
          'Al-Hasa': 'Al-Ahsa',
        },
      },

      // "Region" is a cleaned grouping derived from the raw Branch value.
      // Maps raw Branch Name -> canonical Region. Unmatched branches fall
      // back to the raw (trimmed) branch value.
      regionFromBranch: {
        'Riyadh': 'Riyadh',
        'tala dammam': 'Dammam',
        'Dammam': 'Dammam',
        'Tala -jedahh': 'Jeddah',
        'Tala jeddah': 'Jeddah',
      },
    },

    /* ---- Doc-type classification ----------------------------------------
     * Used to split sales vs returns and to badge tables.
     * -------------------------------------------------------------------- */
    docTypes: {
      // Any docType containing one of these (case-insensitive) counts as a return.
      returnKeywords: ['return', 'credit note'],
      // Positive sales doc types.
      salesKeywords: ['sales', 'debit note'],
    },

    /* ---- Filters ---------------------------------------------------------
     * Order and labelling of the global filter bar. `field` must be a logical
     * dimension the dataStore builds (see dataStore.buildDimensions). Set
     * `enabled:false` (or point field at a missing column) to hide one.
     *
     * NOTE ON THIS DATASET: it has no dedicated Route or Brand column, so
     * those two filters map to sensible proxies — Route -> Branch (territory),
     * Brand -> Sub-Category. Repoint them here the moment real columns exist.
     * -------------------------------------------------------------------- */
    filters: [
      { field: 'month',      label: 'Month',      icon: 'fa-calendar' },
      { field: 'region',     label: 'Region',     icon: 'fa-map-location-dot' },
      { field: 'city',       label: 'City',       icon: 'fa-city' },
      { field: 'branch',     label: 'Branch',     icon: 'fa-building' },
      { field: 'channel',    label: 'Channel',    icon: 'fa-store' },
      { field: 'supervisor', label: 'Supervisor', icon: 'fa-user-tie' },
      { field: 'salesman',   label: 'Salesman',   icon: 'fa-user' },
      { field: 'route',      label: 'Route',      icon: 'fa-route' },      // proxy: branch
      { field: 'category',   label: 'Category',   icon: 'fa-tags' },
      { field: 'brand',      label: 'Brand',      icon: 'fa-cubes' },      // proxy: sub-category
    ],

    /* ---- KPI business rules ---------------------------------------------- */
    kpis: {
      // A customer is "Active" if their most recent purchase is within this
      // many days of the latest Doc Date in the (filtered) data.
      activeWindowDays: 90,

      // Achievement % = actual net sales / target. Target is derived from a
      // monthly figure × number of months in view unless overridden.
      monthlyTargetSar: 1_600_000,

      // Growth % = latest full month vs previous month (net sales).

      // No accounts-receivable data exists in this file, so Collection /
      // Outstanding are derived from an assumed collection rate on invoiced
      // value (Total With Vat). Adjust or wire to real AR data when available.
      collectionRatePct: 0.85,
    },

    /* ---- Chart tuning ----------------------------------------------------- */
    charts: {
      topCustomers: 20,
      topSalesmen: 15,
      topProducts: 20,
      topCities: 12,
      paretoOn: 'customer', // 'customer' | 'product'
    },

    /* ---- Brand palette (kept in sync with CSS custom properties) --------- */
    palette: {
      primary:   '#E4002B', // Roshen red
      secondary: '#7A2E8E',
      series: [
        '#E4002B', '#7A2E8E', '#F5A623', '#2E86DE', '#16A085',
        '#E67E22', '#8E44AD', '#27AE60', '#C0392B', '#2980B9',
        '#D35400', '#1ABC9C',
      ],
    },
  };

  global.DASHBOARD_CONFIG = CONFIG;
})(window);
