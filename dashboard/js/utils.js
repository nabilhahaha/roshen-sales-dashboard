/* ============================================================================
 * utils.js — small, dependency-free helpers (formatting, DOM, timing, export)
 * Exposed as the global `Utils`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const CFG = global.DASHBOARD_CONFIG;
  const locale = (CFG && CFG.app.locale) || 'en-US';
  const currency = (CFG && CFG.app.currency) || 'SAR';

  const _num0 = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const _num2 = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const _cur = new Intl.NumberFormat(locale, {
    style: 'currency', currency, maximumFractionDigits: 0,
  });

  const Utils = {
    /* ---- Number / currency formatting --------------------------------- */
    num(v) { return _num0.format(Number(v) || 0); },
    num2(v) { return _num2.format(Number(v) || 0); },
    money(v) { return _cur.format(Number(v) || 0); },

    /** Compact currency: 1.2M SAR / 340K SAR — for KPI cards & axes. */
    moneyShort(v) {
      const n = Number(v) || 0;
      const abs = Math.abs(n);
      const sign = n < 0 ? '-' : '';
      let out;
      if (abs >= 1e9) out = (abs / 1e9).toFixed(2) + 'B';
      else if (abs >= 1e6) out = (abs / 1e6).toFixed(2) + 'M';
      else if (abs >= 1e3) out = (abs / 1e3).toFixed(1) + 'K';
      else out = Math.round(abs).toString();
      return `${sign}${out}`;
    },

    numShort(v) {
      const n = Math.abs(Number(v) || 0);
      const sign = (Number(v) || 0) < 0 ? '-' : '';
      if (n >= 1e6) return sign + (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return sign + (n / 1e3).toFixed(1) + 'K';
      return sign + Math.round(n);
    },

    pct(v, digits = 1) {
      const n = Number(v);
      if (!isFinite(n)) return '—';
      return `${n.toFixed(digits)}%`;
    },

    /* ---- Date helpers -------------------------------------------------- */
    /** Excel serial or Date or string -> JS Date (or null). */
    toDate(v) {
      if (v == null || v === '') return null;
      if (v instanceof Date) return isNaN(v) ? null : v;
      if (typeof v === 'number') {
        // Excel serial date (days since 1899-12-30).
        const ms = Math.round((v - 25569) * 86400 * 1000);
        const d = new Date(ms);
        return isNaN(d) ? null : d;
      }
      const d = new Date(v);
      return isNaN(d) ? null : d;
    },
    ymd(d) {
      if (!(d instanceof Date)) return '';
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${d.getFullYear()}-${m}-${day}`;
    },
    ym(d) {
      if (!(d instanceof Date)) return '';
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${d.getFullYear()}-${m}`;
    },
    monthLabel(ym) {
      // "2026-01" -> "Jan 2026"
      const [y, m] = String(ym).split('-');
      const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${names[Number(m) - 1] || m} ${y}`;
    },

    /* ---- Misc ---------------------------------------------------------- */
    /** Coerce a cell to a finite number (handles "1,234.5", "", null). */
    toNumber(v) {
      if (typeof v === 'number') return isFinite(v) ? v : 0;
      if (v == null) return 0;
      const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      return isFinite(n) ? n : 0;
    },

    debounce(fn, wait = 180) {
      let t;
      return function (...args) {
        clearTimeout(t);
        t = setTimeout(() => fn.apply(this, args), wait);
      };
    },

    /** requestIdleCallback with a setTimeout fallback. */
    idle(fn) {
      if ('requestIdleCallback' in global) global.requestIdleCallback(fn, { timeout: 400 });
      else setTimeout(fn, 0);
    },

    /* ---- Tiny DOM helpers --------------------------------------------- */
    el(id) { return document.getElementById(id); },
    qs(sel, root = document) { return root.querySelector(sel); },
    qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },
    /** Create an element with props/attributes and children. */
    h(tag, props = {}, children = []) {
      const node = document.createElement(tag);
      Object.entries(props).forEach(([k, v]) => {
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (v != null) node.setAttribute(k, v);
      });
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
      return node;
    },

    /* ---- CSV export (used by tables & "export all") -------------------- */
    toCSV(rows) {
      // rows: array of arrays. Quotes values containing separators/quotes.
      const esc = (val) => {
        const s = val == null ? '' : String(val);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return rows.map((r) => r.map(esc).join(',')).join('\r\n');
    },
    downloadCSV(filename, rows) {
      const blob = new Blob(['﻿' + Utils.toCSV(rows)], { type: 'text/csv;charset=utf-8;' });
      Utils.downloadBlob(filename, blob);
    },
    downloadBlob(filename, blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    /** Stable, readable timestamp for filenames. */
    stamp() {
      const d = new Date();
      return `${Utils.ymd(d)}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    },
  };

  global.Utils = Utils;
})(window);
