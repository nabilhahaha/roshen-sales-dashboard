/* ============================================================================
 * upload.js — drag & drop / browse Excel upload with loading + error UX.
 * ----------------------------------------------------------------------------
 * Reads the file into an ArrayBuffer, hands it to DataStore, and invokes the
 * provided callback on success. All heavy parsing lives in DataStore; this
 * module only owns the interaction and feedback.
 *
 * Exposed as the global `Upload`.
 * ========================================================================== */
(function (global) {
  'use strict';

  const U = global.Utils;
  const DS = global.DataStore;

  let onLoaded = () => {};

  function setStatus(msg, kind) {
    const box = U.el('upload-status');
    if (!box) return;
    box.className = 'upload-status ' + (kind || '');
    box.innerHTML = msg;
  }

  function showLoader(show, label) {
    const l = U.el('global-loader');
    if (!l) return;
    if (label) U.el('loader-label').textContent = label;
    l.classList.toggle('active', !!show);
  }

  async function handleFile(file) {
    if (!file) return;
    const okExt = /\.(xlsx|xlsm|xls|csv)$/i.test(file.name);
    if (!okExt) {
      setStatus(`<i class="fa-solid fa-triangle-exclamation"></i> Unsupported file type. Please upload .xlsx / .xls / .csv`, 'error');
      return;
    }
    showLoader(true, `Reading “${file.name}” …`);
    setStatus(`<i class="fa-solid fa-spinner fa-spin"></i> Parsing ${(file.size / 1048576).toFixed(1)} MB …`, 'info');

    try {
      const buf = await file.arrayBuffer();
      // Defer to next frame so the loader paints before the (sync) parse.
      await new Promise((r) => requestAnimationFrame(() => r()));
      const res = await DS.loadArrayBuffer(buf, file.name);

      if (!res.rowCount) throw new Error('No data rows found in the file.');
      let msg = `<i class="fa-solid fa-circle-check"></i> Loaded <b>${U.num(res.rowCount)}</b> rows from “${file.name}”.`;
      if (res.warnings.length) msg += `<div class="warn-line"><i class="fa-solid fa-triangle-exclamation"></i> ${res.warnings.join('; ')}</div>`;
      setStatus(msg, 'success');
      onLoaded(res);
    } catch (err) {
      console.error(err);
      setStatus(`<i class="fa-solid fa-circle-xmark"></i> ${err.message || 'Failed to read the file.'}`, 'error');
    } finally {
      showLoader(false);
    }
  }

  const Upload = {
    showLoader,

    init(loadedCb) {
      onLoaded = loadedCb || onLoaded;
      const dz = U.el('dropzone');
      const input = U.el('file-input');
      if (!dz || !input) return;

      // Browse
      U.qsa('[data-browse]').forEach((b) => b.addEventListener('click', () => input.click()));
      input.addEventListener('change', (e) => { if (e.target.files[0]) handleFile(e.target.files[0]); input.value = ''; });

      // Drag & drop
      ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation(); dz.classList.add('dragover');
      }));
      ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
        dz.classList.remove('dragover');
      }));
      dz.addEventListener('drop', (e) => {
        const f = e.dataTransfer.files[0];
        if (f) handleFile(f);
      });

      // Also allow dropping anywhere on the window once data is loaded.
      window.addEventListener('dragover', (e) => e.preventDefault());
      window.addEventListener('drop', (e) => {
        if (e.target.closest('#dropzone')) return; // handled above
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files[0];
        if (f && DS.isLoaded()) handleFile(f);
      });

      // Load bundled sample (works when served over http; file:// is blocked by CORS).
      const sample = U.el('btn-sample');
      if (sample) sample.addEventListener('click', () => Upload.loadSample());
    },

    async loadSample() {
      showLoader(true, 'Loading sample data …');
      setStatus('<i class="fa-solid fa-spinner fa-spin"></i> Fetching sample workbook …', 'info');
      try {
        const resp = await fetch('sample-data/Sample_Sales_Data.xlsx');
        if (!resp.ok) throw new Error('Sample file not found.');
        const buf = await resp.arrayBuffer();
        const res = await DS.loadArrayBuffer(buf, 'Sample_Sales_Data.xlsx');
        setStatus(`<i class="fa-solid fa-circle-check"></i> Loaded sample data (${U.num(res.rowCount)} rows).`, 'success');
        onLoaded(res);
      } catch (err) {
        setStatus(`<i class="fa-solid fa-circle-xmark"></i> ${err.message}. If you opened index.html directly, run a local server (see README) or just drag your Excel file in.`, 'error');
      } finally {
        showLoader(false);
      }
    },
  };

  global.Upload = Upload;
})(window);
