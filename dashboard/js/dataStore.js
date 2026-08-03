/* ============================================================================
 * dataStore.js — parse, normalise and filter the sales data.
 * ----------------------------------------------------------------------------
 * Responsibilities:
 *   1. Parse an uploaded .xlsx (SheetJS) into raw JSON rows.
 *   2. Map raw columns -> logical fields using DASHBOARD_CONFIG.columns.
 *   3. Normalise dimension values (region/city cleanup, blanks, returns flag).
 *   4. Precompute per-row derived fields (ym, ymd, region) ONCE.
 *   5. Expose fast, single-pass filtering for the global filter bar.
 *
 * Performance: normalisation happens one time on upload. Filtering is a single
 * O(n) pass with cheap equality checks, so it stays instant well beyond 100k
 * rows. Aggregation (aggregations.js) also runs in one pass over the filtered
 * set, so a filter change is effectively 2×O(n) — milliseconds for 100k rows.
 *
 * Exposed as the global `DataStore`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const U = global.Utils;

  /** Normalise a header for tolerant matching: lowercase, collapse spaces. */
  function normHeader(h) {
    return String(h == null ? '' : h).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /** Trim + collapse whitespace; return null for blanks. */
  function cleanStr(v) {
    if (v == null) return null;
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
  }

  const DataStore = {
    rows: [],            // normalised records (see _makeRecord)
    dimensions: {},      // { region: [..], city: [..], ... } sorted unique values
    meta: {              // dataset summary
      fileName: null, sheetName: null, rowCount: 0,
      minDate: null, maxDate: null, loadedAt: null,
      missingColumns: [],
    },
    filters: {},         // active filter state { field: valueOrNull, dateFrom, dateTo }

    /* ------------------------------------------------------------------ *
     * Parsing
     * ------------------------------------------------------------------ */

    /**
     * Parse an ArrayBuffer into normalised rows.
     * @returns {Promise<{rowCount:number, warnings:string[]}>}
     */
    async loadArrayBuffer(buf, fileName) {
      const isXlsx = !fileName || /\.xlsx$/i.test(fileName);
      let sheetName = null;
      let aoa = null;

      // 1) Fast path: custom .xlsx parser (~15-20× faster on verbose exports).
      if (isXlsx && global.FastXLSX) {
        try {
          const res = await global.FastXLSX.parse(buf, CFG.app.preferredSheet);
          sheetName = res.sheetName;
          aoa = res.aoa;
        } catch (e) {
          console.warn('FastXLSX fell back to SheetJS:', e.message);
        }
      }

      // 2) Compatibility path: SheetJS (also handles .xls / .csv / odd files).
      if (!aoa) {
        if (!global.XLSX) throw new Error('SheetJS (XLSX) failed to load.');
        const wb = XLSX.read(buf, { type: 'array', cellDates: true, dense: true });
        sheetName = (CFG.app.preferredSheet && wb.SheetNames.includes(CFG.app.preferredSheet))
          ? CFG.app.preferredSheet
          : wb.SheetNames[0];
        if (!sheetName) throw new Error('The workbook has no sheets.');
        const ws = wb.Sheets[sheetName];
        // header:1 -> array-of-arrays: fastest, lets us build our own typed records.
        aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false });
      }
      if (!aoa.length) throw new Error('The selected sheet is empty.');

      const headerRow = aoa[0].map(normHeader);
      const { index, missing } = this._resolveColumns(headerRow);
      if (index.netAmount == null && index.grossSales == null) {
        throw new Error('Could not find the sales-amount column. Check js/config.js column mapping.');
      }

      const rows = new Array(aoa.length - 1);
      let n = 0, minD = null, maxD = null;
      for (let i = 1; i < aoa.length; i++) {
        const raw = aoa[i];
        if (!raw || raw.length === 0) continue;
        const rec = this._makeRecord(raw, index);
        if (rec.date) {
          if (!minD || rec.date < minD) minD = rec.date;
          if (!maxD || rec.date > maxD) maxD = rec.date;
        }
        rows[n++] = rec;
      }
      rows.length = n;

      this.rows = rows;
      this.meta = {
        fileName: fileName || null,
        sheetName,
        rowCount: n,
        minDate: minD, maxDate: maxD,
        loadedAt: new Date(),
        missingColumns: missing,
      };
      this._buildDimensions();
      this.resetFilters();

      return { rowCount: n, warnings: missing.length
        ? [`Missing columns (ignored): ${missing.join(', ')}`] : [] };
    },

    /** Resolve config.columns -> raw column indices. Returns {index, missing}. */
    _resolveColumns(headerRow) {
      const lookup = new Map();
      headerRow.forEach((h, i) => { if (!lookup.has(h)) lookup.set(h, i); });

      const index = {};
      const missing = [];
      Object.entries(CFG.columns).forEach(([field, header]) => {
        const aliases = Array.isArray(header) ? header : [header];
        let found = null;
        for (const a of aliases) {
          const idx = lookup.get(normHeader(a));
          if (idx != null) { found = idx; break; }
        }
        if (found == null) missing.push(Array.isArray(header) ? header[0] : header);
        else index[field] = found;
      });
      return { index, missing };
    },

    /** Build one compact, typed record from a raw row array. */
    _makeRecord(raw, idx) {
      const get = (f) => (idx[f] == null ? null : raw[idx[f]]);

      const branchRaw = cleanStr(get('branch'));
      const region = this._regionOf(branchRaw);
      const cityRaw = cleanStr(get('city'));
      const city = this._applyReplace('city', cityRaw) || CFG.normalize.blankLabel;

      const docType = cleanStr(get('docType')) || CFG.normalize.blankLabel;
      const date = U.toDate(get('docDate'));

      const sales = U.toNumber(get(CFG.salesMeasure));

      return {
        // measures
        sales,                                   // signed net (returns negative)
        gross: U.toNumber(get('grossSales')),
        withVat: U.toNumber(get('totalWithVat')),
        discount: U.toNumber(get('discountAmount')),
        qty: U.toNumber(get('qtyPcs')),
        // product
        product: cleanStr(get('productName')) || CFG.normalize.blankLabel,
        itemId: cleanStr(get('itemId')) || '',
        category: cleanStr(get('category')) || CFG.normalize.blankLabel,
        subCategory: cleanStr(get('subCategory')) || CFG.normalize.blankLabel,
        // org / geo
        city,
        branch: branchRaw || CFG.normalize.blankLabel,
        region,
        channel: cleanStr(get('channel')) || CFG.normalize.blankLabel,
        supervisor: cleanStr(get('supervisorName')) || CFG.normalize.blankLabel,
        salesman: cleanStr(get('salesmanName')) || CFG.normalize.blankLabel,
        customer: cleanStr(get('customerName')) || CFG.normalize.blankLabel,
        customerId: String(get('customerId') == null ? '' : get('customerId')).trim(),
        // document
        date,
        ts: date ? date.getTime() : 0,
        ym: date ? U.ym(date) : '',
        ymd: date ? U.ymd(date) : '',
        docId: String(get('docId') == null ? '' : get('docId')).trim(),
        docType,
        isReturn: this._isReturn(docType),
      };
    },

    _regionOf(branchRaw) {
      if (!branchRaw) return CFG.normalize.blankLabel;
      const map = CFG.normalize.regionFromBranch || {};
      return map[branchRaw] || branchRaw;
    },
    _applyReplace(field, val) {
      if (val == null) return null;
      const rep = (CFG.normalize.replacements || {})[field];
      return rep && rep[val] ? rep[val] : val;
    },
    _isReturn(docType) {
      const t = String(docType).toLowerCase();
      return CFG.docTypes.returnKeywords.some((k) => t.includes(k));
    },

    /* ------------------------------------------------------------------ *
     * Dimensions & filtering
     * ------------------------------------------------------------------ */

    /** Map a filter field -> record property (handles Route/Brand proxies). */
    _fieldProp(field) {
      switch (field) {
        case 'route': return 'branch';       // proxy — repoint in config notes
        case 'brand': return 'subCategory';  // proxy
        default: return field;               // region, city, channel, supervisor, salesman, category, month(ym)
      }
    },

    _buildDimensions() {
      const fields = ['region', 'city', 'branch', 'channel', 'supervisor', 'salesman', 'category', 'subCategory'];
      const sets = {};
      fields.forEach((f) => (sets[f] = new Set()));
      const months = new Set();

      for (const r of this.rows) {
        fields.forEach((f) => sets[f].add(r[f]));
        if (r.ym) months.add(r.ym);
      }
      const dims = {};
      fields.forEach((f) => {
        dims[f] = Array.from(sets[f]).filter(Boolean).sort((a, b) => a.localeCompare(b));
      });
      dims.month = Array.from(months).sort(); // "YYYY-MM" sorts chronologically
      // proxies reuse existing lists
      dims.route = dims.branch;
      dims.brand = dims.subCategory;
      this.dimensions = dims;
    },

    resetFilters() {
      this.filters = { dateFrom: null, dateTo: null };
      (CFG.filters || []).forEach((f) => (this.filters[f.field] = null));
    },

    setFilter(field, value) {
      this.filters[field] = (value === '' || value == null) ? null : value;
    },
    setDateRange(from, to) {
      this.filters.dateFrom = from ? U.toDate(from) : null;
      this.filters.dateTo = to ? U.toDate(to) : null;
      if (this.filters.dateTo) this.filters.dateTo.setHours(23, 59, 59, 999);
    },

    hasActiveFilters() {
      const f = this.filters;
      if (f.dateFrom || f.dateTo) return true;
      return (CFG.filters || []).some((cf) => f[cf.field] != null);
    },

    /**
     * Single-pass filter. Returns a NEW array of matching records.
     * Kept branch-lean so it scales to 100k+ rows comfortably.
     */
    getFilteredRows() {
      const f = this.filters;
      if (!this.hasActiveFilters()) return this.rows;

      // Pre-resolve active dimension filters into [prop, value] pairs.
      const active = [];
      (CFG.filters || []).forEach((cf) => {
        const v = f[cf.field];
        if (v == null) return;
        if (cf.field === 'month') active.push(['ym', v]);
        else active.push([this._fieldProp(cf.field), v]);
      });
      const from = f.dateFrom ? f.dateFrom.getTime() : null;
      const to = f.dateTo ? f.dateTo.getTime() : null;

      const out = [];
      const rows = this.rows;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (from != null && (r.ts === 0 || r.ts < from)) continue;
        if (to != null && (r.ts === 0 || r.ts > to)) continue;
        let ok = true;
        for (let k = 0; k < active.length; k++) {
          if (r[active[k][0]] !== active[k][1]) { ok = false; break; }
        }
        if (ok) out.push(r);
      }
      return out;
    },

    isLoaded() { return this.rows.length > 0; },
  };

  global.DataStore = DataStore;
})(window);
