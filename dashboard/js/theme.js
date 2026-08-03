/* ============================================================================
 * theme.js — dark/light mode, print, and "export dashboard to PDF".
 * Exposed as the global `Theme`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const U = global.Utils;
  const KEY = 'roshen_dash_theme';

  const Theme = {
    onChange: () => {},

    get() { return document.documentElement.getAttribute('data-theme') || 'light'; },

    set(mode, persist = true) {
      document.documentElement.setAttribute('data-theme', mode);
      if (persist) { try { localStorage.setItem(KEY, mode); } catch (e) {} }
      const icon = U.el('theme-icon');
      if (icon) icon.className = mode === 'dark' ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
      this.onChange(mode);
    },

    toggle() { this.set(this.get() === 'dark' ? 'light' : 'dark'); },

    init(onChange) {
      this.onChange = onChange || this.onChange;
      let saved = 'light';
      try { saved = localStorage.getItem(KEY) || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); } catch (e) {}
      this.set(saved, false);

      const btn = U.el('btn-theme');
      if (btn) btn.addEventListener('click', () => this.toggle());
      const printBtn = U.el('btn-print');
      if (printBtn) printBtn.addEventListener('click', () => window.print());
      const pdfBtn = U.el('btn-export-pdf');
      if (pdfBtn) pdfBtn.addEventListener('click', () => this.exportPDF());
    },

    /**
     * Export the currently visible dashboard to a multi-page PDF using
     * html2canvas + jsPDF (loaded via CDN). Falls back to print if missing.
     */
    async exportPDF() {
      const jspdfNS = global.jspdf || global.jsPDF;
      if (!global.html2canvas || !jspdfNS) { window.print(); return; }
      const { jsPDF } = jspdfNS;

      global.Upload && global.Upload.showLoader(true, 'Rendering PDF …');
      try {
        const node = U.el('capture-root');
        const canvas = await global.html2canvas(node, {
          scale: 2, useCORS: true, backgroundColor: getComputedStyle(document.body).backgroundColor,
          windowWidth: node.scrollWidth,
        });
        const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
        const pw = pdf.internal.pageSize.getWidth();
        const ph = pdf.internal.pageSize.getHeight();
        const imgW = pw - 32;
        const imgH = (canvas.height * imgW) / canvas.width;
        let left = imgH;
        let position = 16;
        pdf.addImage(canvas, 'PNG', 16, position, imgW, imgH, '', 'FAST');
        left -= (ph - 32);
        while (left > 0) {
          position = position - (ph - 32);
          pdf.addPage();
          pdf.addImage(canvas, 'PNG', 16, position + 16, imgW, imgH, '', 'FAST');
          left -= (ph - 32);
        }
        pdf.save(`Roshen_Dashboard_${U.stamp()}.pdf`);
      } catch (e) {
        console.error(e);
        window.print();
      } finally {
        global.Upload && global.Upload.showLoader(false);
      }
    },
  };

  global.Theme = Theme;
})(window);
