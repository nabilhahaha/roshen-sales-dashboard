/* ============================================================================
 * fastParser.js — high-performance .xlsx reader (fast path).
 * ----------------------------------------------------------------------------
 * SheetJS is the compatibility workhorse, but on verbose exports (a 37k-row
 * file from the ERP carries ~44 MB of worksheet XML) XLSX.read takes 15-20s.
 * This module parses the same file in ~1s by:
 *   1. unzipping with JSZip (already bundled for the Excel export button),
 *   2. resolving the first/preferred worksheet via workbook.xml + rels,
 *   3. decoding sharedStrings.xml,
 *   4. scanning row/cell XML with tight regexes.
 *
 * It returns an array-of-arrays identical in shape to
 * XLSX.utils.sheet_to_json(ws, {header:1}). Dates arrive as Excel serial
 * numbers, which Utils.toDate already converts.
 *
 * DataStore tries this first and silently falls back to SheetJS on ANY error
 * or suspicious output, so correctness never depends on this fast path.
 *
 * Exposed as the global `FastXLSX`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const XML_ENTITIES = [
    [/&lt;/g, '<'], [/&gt;/g, '>'], [/&quot;/g, '"'], [/&apos;/g, "'"],
    [/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)], [/&amp;/g, '&'],
  ];
  function decodeXml(s) {
    if (s.indexOf('&') === -1) return s;
    for (const [re, rep] of XML_ENTITIES) s = s.replace(re, rep);
    return s;
  }

  /** Concatenate all <t> runs inside an <si> / <is> fragment. */
  function textRuns(fragment) {
    let out = '';
    const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let m;
    while ((m = re.exec(fragment))) out += m[1];
    // self-closing <t/> yields nothing — fine (empty string cell)
    return decodeXml(out);
  }

  /** "AB" -> 27 (0-based col index) */
  function colIndex(letters) {
    let c = 0;
    for (let i = 0; i < letters.length; i++) c = c * 26 + (letters.charCodeAt(i) - 64);
    return c - 1;
  }

  const FastXLSX = {
    /**
     * Parse an .xlsx ArrayBuffer.
     * @param {ArrayBuffer} buf
     * @param {?string} preferredSheet sheet name to prefer (else first sheet)
     * @returns {Promise<{sheetName:string, aoa:Array<Array>}>}
     */
    async parse(buf, preferredSheet) {
      if (!global.JSZip) throw new Error('JSZip unavailable');
      const zip = await JSZip.loadAsync(buf);

      // ---- locate the target worksheet via workbook + rels ----
      const wbFile = zip.file('xl/workbook.xml');
      if (!wbFile) throw new Error('Not a valid .xlsx (no workbook.xml)');
      const wbXml = await wbFile.async('string');

      // 1904-date-system workbooks (legacy Mac Excel) would need per-cell style
      // inspection to shift only date cells — hand those to SheetJS instead.
      if (/date1904\s*=\s*"(?:1|true)"/i.test(wbXml)) {
        throw new Error('1904 date system — using SheetJS fallback');
      }

      const sheets = [];
      const shElRe = /<sheet\b[^>]*\/?>/g;
      let sm;
      while ((sm = shElRe.exec(wbXml))) {
        const el = sm[0];
        const nameM = /\bname="([^"]*)"/.exec(el);
        const ridM = /\br:id="([^"]*)"/.exec(el);
        if (nameM && ridM) sheets.push({ name: decodeXml(nameM[1]), rid: ridM[1] });
      }
      if (!sheets.length) throw new Error('No sheets found');

      const target = (preferredSheet && sheets.find((s) => s.name === preferredSheet)) || sheets[0];

      const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('string');
      // Attribute order varies by producer (Excel: Id first; openpyxl: Target
      // first) — match the whole element, then read attributes independently.
      let targetPath = null;
      const relElRe = /<Relationship\b[^>]*\/?>/g;
      let re;
      while ((re = relElRe.exec(relsXml))) {
        const el = re[0];
        const idM = /\bId="([^"]*)"/.exec(el);
        if (idM && idM[1] === target.rid) {
          const tM = /\bTarget="([^"]*)"/.exec(el);
          if (tM) targetPath = tM[1];
          break;
        }
      }
      if (!targetPath) throw new Error('Worksheet relationship not found');
      let path = targetPath.replace(/^\//, '');
      if (!path.startsWith('xl/')) path = 'xl/' + path;

      const wsFile = zip.file(path);
      if (!wsFile) throw new Error('Worksheet part missing: ' + path);

      // ---- shared strings ----
      const ssFile = zip.file('xl/sharedStrings.xml');
      const strings = [];
      if (ssFile) {
        const ssXml = await ssFile.async('string');
        const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
        let m;
        while ((m = siRe.exec(ssXml))) strings.push(textRuns(m[1]));
      }

      // ---- worksheet rows ----
      const wsXml = await wsFile.async('string');
      const aoa = [];
      const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
      const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      const refRe = /\br="([A-Z]+)(\d+)"/;
      const typeRe = /\bt="(\w+)"/;
      const vRe = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/;

      let rm;
      while ((rm = rowRe.exec(wsXml))) {
        const inner = rm[1];
        const cells = [];
        let cm;
        cellRe.lastIndex = 0;
        while ((cm = cellRe.exec(inner))) {
          const attrs = cm[1];
          const body = cm[2] || '';
          const ref = refRe.exec(attrs);
          if (!ref) continue;
          const col = colIndex(ref[1]);
          const ty = typeRe.exec(attrs);
          const t = ty ? ty[1] : null;
          let val = null;

          if (t === 'inlineStr') {
            val = textRuns(body);
          } else {
            const vm = vRe.exec(body);
            if (vm) {
              if (t === 's') val = strings[+vm[1]];
              else if (t === 'str' || t === 'e') val = decodeXml(vm[1]);
              else if (t === 'b') val = vm[1] === '1';
              else val = +vm[1]; // numbers & date serials (Utils.toDate converts)
            }
          }
          cells[col] = val;
        }
        if (cells.length) aoa.push(cells);
      }

      if (aoa.length < 2) throw new Error('Fast parser produced no data rows');
      return { sheetName: target.name, aoa };
    },
  };

  global.FastXLSX = FastXLSX;
})(window);
