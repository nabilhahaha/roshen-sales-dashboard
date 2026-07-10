// Lazy attachments panel — reusable for PI / Delivery Note / Supplier Invoice.
//
// Renders collapsed (a header with a lazy count); NOTHING else is fetched
// until the user expands it. Files upload straight to Supabase Storage
// (drag-and-drop or file picker, multiple at once, any supported format);
// the list shows metadata only; preview/download stream from storage on
// demand. Replace uploads a new revision and keeps the old one in history.
import { esc } from '../../utils/format.js';
import { toast } from '../notifications/toast.js';
import { openDrawer } from '../document/document-shell.js';
import {
  listAttachments, countAttachments, uploadAttachment, attachmentUrl,
  attachmentHistory, canPreview, kindOf, ACCEPT_ATTR,
} from '../../services/attachments/attachments.service.js';

const ICON = { pdf: '📄', image: '🖼', sheet: '📊' };

// Universal in-page preview (drawer) — the user NEVER leaves the screen.
//   PDF: native viewer (zoom/fit) + Print + Download
//   Images: zoom / rotate / full screen / download
//   Excel: worksheet tabs + first rows, parsed in place
//   Email (.eml): subject / from / to / cc / date / body
//   Word / .msg: "Preview unavailable" + download
// opts.list + opts.index enable ← / → navigation across the attachment set.
export function previewAttachment(att, opts = {}) {
  const url = attachmentUrl(att);
  const k = kindOf(att.mime || att.filename);
  const list = opts.list || null, idx = opts.index || 0;
  const fmtWhen0 = (t) => esc(String(t || '').slice(0, 16).replace('T', ' '));

  const info = `<div style="display:flex;gap:18px;flex-wrap:wrap;font-size:11.5px;color:var(--text-secondary);margin:0 0 10px">
    <span>Type: <b>${esc(k)}</b></span>
    ${att.byte_size ? `<span>Size: <b>${att.byte_size >= 1048576 ? (att.byte_size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(att.byte_size / 1024)) + ' KB'}</b></span>` : ''}
    <span>Uploaded: <b>${fmtWhen0(att.created_at)}</b></span>
    <span>By: <b>${esc(att.uploaded_by || '—')}</b></span>
    <span>Version: <b>${att.revision || 1}</b></span>
    ${att.doc_label ? `<span>Source: <b>${esc(att.doc_label)}</b></span>` : ''}
  </div>`;
  const nav = list && list.length > 1
    ? `<button class="sc-btn sm ghost" data-p="prev" title="Previous (←)">←</button>
       <span style="font-size:11px;color:var(--text-muted)">${idx + 1}/${list.length}</span>
       <button class="sc-btn sm ghost" data-p="next" title="Next (→)">→</button>` : '';

  let inner = '';
  if (k === 'image') {
    inner = `<div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <button class="sc-btn sm ghost" data-p="zin">🔍+</button><button class="sc-btn sm ghost" data-p="zout">🔍−</button>
        <button class="sc-btn sm ghost" data-p="rot">⟳ Rotate</button><button class="sc-btn sm ghost" data-p="fs">⛶ Full Screen</button></div>
      <div style="overflow:auto;max-height:calc(100vh - 220px)"><img data-p="img" src="${esc(url)}" alt="${esc(att.filename || '')}" style="transform-origin:top left"></div>`;
  } else if (k === 'pdf') {
    inner = `<div style="display:flex;gap:8px;margin-bottom:8px"><button class="sc-btn sm ghost" data-p="print">🖨 Print (Ctrl+P)</button>
      <span style="font-size:11px;color:var(--text-muted);align-self:center">zoom / fit controls are in the viewer toolbar</span></div>
      <iframe data-p="pdf" src="${esc(url)}" title="${esc(att.filename || '')}"></iframe>`;
  } else if (k === 'sheet') {
    inner = '<div data-p="xl"><p style="font-size:12px;color:var(--text-muted)">Reading workbook…</p></div>';
  } else if (k === 'email') {
    inner = '<div data-p="eml"><p style="font-size:12px;color:var(--text-muted)">Reading message…</p></div>';
  } else {
    inner = '<div class="sc-empty"><div class="ic">📄</div><p>Preview unavailable for this file type — download the original instead.</p></div>';
  }

  const body = openDrawer(att.filename || 'Preview', `${info}
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
      <a class="sc-btn sm" href="${esc(url)}?download=${encodeURIComponent(att.filename || 'file')}" download>⬇ Download</a>${nav}
    </div>${inner}`);

  // image controls
  let zoom = 1, rot = 0;
  const img = body.querySelector('[data-p="img"]');
  const apply = () => { if (img) img.style.transform = `scale(${zoom}) rotate(${rot}deg)`; };
  body.querySelectorAll('[data-p]').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.p;
    if (a === 'zin') { zoom = Math.min(4, zoom + 0.25); apply(); }
    if (a === 'zout') { zoom = Math.max(0.25, zoom - 0.25); apply(); }
    if (a === 'rot') { rot = (rot + 90) % 360; apply(); }
    if (a === 'fs' && img && img.requestFullscreen) img.requestFullscreen();
    if (a === 'print') {
      const f = body.querySelector('[data-p="pdf"]');
      try { f.contentWindow.print(); } catch (e) { window.open(url, '_blank'); }
    }
    if (a === 'prev' && list) previewAttachment(list[(idx - 1 + list.length) % list.length], { ...opts, index: (idx - 1 + list.length) % list.length });
    if (a === 'next' && list) previewAttachment(list[(idx + 1) % list.length], { ...opts, index: (idx + 1) % list.length });
  }));
  // keyboard: ← / → across the set, Ctrl+P prints
  const keys = (e) => {
    if (!document.querySelector('.doc-drawer-overlay')) { document.removeEventListener('keydown', keys); return; }
    if (e.key === 'ArrowLeft' && list) { e.preventDefault(); previewAttachment(list[(idx - 1 + list.length) % list.length], { ...opts, index: (idx - 1 + list.length) % list.length }); }
    if (e.key === 'ArrowRight' && list) { e.preventDefault(); previewAttachment(list[(idx + 1) % list.length], { ...opts, index: (idx + 1) % list.length }); }
    if ((e.ctrlKey || e.metaKey) && e.key === 'p' && k === 'pdf') {
      e.preventDefault();
      const f = body.querySelector('[data-p="pdf"]');
      try { f.contentWindow.print(); } catch (x) { window.open(url, '_blank'); }
    }
  };
  document.addEventListener('keydown', keys);

  // Excel: parse in place with the already-loaded XLSX engine
  if (k === 'sheet' && window.XLSX) {
    fetch(url).then((r) => r.arrayBuffer()).then((ab) => {
      const wb = window.XLSX.read(ab, { type: 'array' });
      const host = body.querySelector('[data-p="xl"]');
      if (!host) return;
      const renderSheet = (name) => {
        const aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' }).slice(0, 30);
        const w = Math.max(1, ...aoa.map((r) => r.length));
        host.querySelector('[data-p="grid"]').innerHTML = `<div class="sc-table-wrap" style="max-height:calc(100vh - 300px);overflow:auto">
          <table class="sc-table" style="min-width:0"><tbody>${aoa.map((r) => `<tr>${Array.from({ length: Math.min(w, 14) }, (_, i) => `<td style="font-size:11px">${esc(String(r[i] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
          <p style="font-size:10.5px;color:var(--text-muted);margin:6px 0 0">first ${aoa.length} row(s) — download the file for the full workbook</p>`;
      };
      host.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px">${wb.SheetNames.map((n, i) =>
        `<button class="sc-btn sm ${i === 0 ? '' : 'ghost'}" data-sheet="${esc(n)}">${esc(n)}</button>`).join('')}</div><div data-p="grid"></div>`;
      host.querySelectorAll('[data-sheet]').forEach((b) => b.addEventListener('click', () => {
        host.querySelectorAll('[data-sheet]').forEach((x) => x.classList.add('ghost'));
        b.classList.remove('ghost'); renderSheet(b.dataset.sheet);
      }));
      renderSheet(wb.SheetNames[0]);
    }).catch(() => { const h = body.querySelector('[data-p="xl"]'); if (h) h.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Could not read the workbook — download it instead.</p>'; });
  }
  // Email (.eml): headers + body, parsed client-side
  if (k === 'email') {
    fetch(url).then((r) => r.text()).then((raw) => {
      const host = body.querySelector('[data-p="eml"]');
      if (!host) return;
      const head = raw.split(/\r?\n\r?\n/)[0] || '';
      const rest = raw.slice(head.length).trim();
      const hv = (n) => { const m = head.match(new RegExp('^' + n + ':\\s*(.+)$', 'im')); return m ? m[1].trim() : ''; };
      host.innerHTML = `<div class="sc-card" style="margin:0 0 10px">
          <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:12px">
            <div><span class="erp-mini">Subject</span><br><b>${esc(hv('Subject') || '—')}</b></div>
            <div><span class="erp-mini">From</span><br><b>${esc(hv('From') || '—')}</b></div>
            <div><span class="erp-mini">To</span><br><b>${esc(hv('To') || '—')}</b></div>
            ${hv('Cc') ? `<div><span class="erp-mini">CC</span><br><b>${esc(hv('Cc'))}</b></div>` : ''}
            <div><span class="erp-mini">Date</span><br><b>${esc(hv('Date') || '—')}</b></div>
          </div></div>
        <pre style="white-space:pre-wrap;font-size:12px;color:var(--text-primary);background:var(--bg-input);border:1px solid var(--border);border-radius:10px;padding:12px;max-height:calc(100vh - 320px);overflow:auto">${esc(rest.slice(0, 20000))}</pre>`;
    }).catch(() => {});
  }
}
const fmtSize = (b) => (b == null ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtWhen = (t) => esc(String(t || '').slice(0, 16).replace('T', ' '));

// attachmentsPanel(el, 'purchase_order', 42, { actor })
export function attachmentsPanel(el, docType, docId, { actor = 'Development' } = {}) {
  // OPEN by default: the original uploaded document (View / Download /
  // uploader / date / version history) must be visible on every document
  // detail page without an extra click.
  let expanded = true;
  let replaceTarget = null; // attachment id being replaced by the next upload

  const shell = () => {
    el.innerHTML = `<div class="sc-card">
      <div class="sc-card-h" style="cursor:pointer" data-a="toggle"><h3>📎 Attachments</h3>
        <span class="sc-badge none" data-a="count">…</span><div class="sc-spacer"></div>
        <span style="font-size:11.5px;color:var(--text-muted)">${expanded ? '▲ hide' : '▼ show'}</span></div>
      <div data-a="body" style="display:${expanded ? 'block' : 'none'}"></div></div>`;
    el.querySelector('[data-a="toggle"]').addEventListener('click', async () => {
      expanded = !expanded; shell();
      if (expanded) paintBody();
    });
    // lazy count only (cheap head query; the list itself loads on expand)
    countAttachments(docType, docId).then((n) => {
      const c = el.querySelector('[data-a="count"]'); if (c) c.textContent = n;
    }).catch(() => {});
    if (expanded) paintBody();
  };

  async function paintBody() {
    const body = el.querySelector('[data-a="body"]');
    if (!body) return;
    body.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">Loading attachments…</p>';
    let atts;
    try { atts = await listAttachments(docType, docId); }
    catch (e) { body.innerHTML = `<p style="font-size:12px;color:#E03131">${esc(e.message || String(e))}</p>`; return; }

    const rows = atts.map((a) => {
      const k = kindOf(a.mime || a.filename);
      return `<tr>
        <td>${ICON[k] || '📎'} <b style="font-size:12.5px">${esc(a.filename)}</b>${a.revision > 1 ? ` <span class="sc-badge approved">rev ${a.revision}</span>` : ''}</td>
        <td style="font-size:11.5px;color:var(--text-muted)">${esc(k)}</td>
        <td style="font-size:11.5px">${fmtSize(a.byte_size)}</td>
        <td style="font-size:11.5px">${fmtWhen(a.created_at)}</td>
        <td style="font-size:11.5px">${esc(a.uploaded_by || '—')}</td>
        <td style="text-align:right;white-space:nowrap">
          ${canPreview(a) ? `<button class="sc-btn sm ghost" data-a="preview" data-id="${a.id}">👁 Preview</button>` : ''}
          <button class="sc-btn sm ghost" data-a="download" data-id="${a.id}">⬇ Download</button>
          <button class="sc-btn sm ghost" data-a="replace" data-id="${a.id}">↻ Replace</button>
          ${a.revision > 1 || a.supersedes_id ? `<button class="sc-btn sm ghost" data-a="history" data-id="${a.id}">🕓</button>` : ''}
        </td></tr>`;
    }).join('');

    body.innerHTML = `
      <div class="erp-drop" data-a="drop" style="padding:16px;margin-bottom:10px">
        <div style="font-weight:700;color:var(--text-primary);font-size:12.5px">Drop files here or click to browse</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:3px">PDF · Excel (xlsx/xls/csv) · Images (jpg/png/heic/webp) — multiple files allowed, stored permanently</div>
        <input type="file" data-a="file" multiple accept="${ACCEPT_ATTR}" style="display:none">
      </div>
      ${atts.length ? `<div class="sc-table-wrap"><table class="sc-table"><thead><tr>
        <th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th>By</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p style="font-size:12px;color:var(--text-muted);margin:0">No attachments yet.</p>'}
      <div data-a="hist"></div>`;

    const byId = {}; atts.forEach((a) => { byId[a.id] = a; });
    const drop = body.querySelector('[data-a="drop"]');
    const file = body.querySelector('[data-a="file"]');
    drop.addEventListener('click', () => { replaceTarget = null; file.click(); });
    ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { if (e.dataTransfer.files && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    file.addEventListener('change', () => { if (file.files && file.files.length) handleFiles(file.files); });

    const previewable = atts.filter((a) => canPreview(a));
    body.querySelectorAll('[data-a="preview"]').forEach((b) => b.addEventListener('click', () => {
      const a = byId[b.dataset.id];
      previewAttachment(a, { list: previewable, index: Math.max(0, previewable.indexOf(a)) });
    }));
    body.querySelectorAll('[data-a="download"]').forEach((b) => b.addEventListener('click', () => {
      const a = byId[b.dataset.id];
      const link = document.createElement('a');
      link.href = attachmentUrl(a) + '?download=' + encodeURIComponent(a.filename);
      link.download = a.filename; document.body.appendChild(link); link.click(); link.remove();
    }));
    body.querySelectorAll('[data-a="replace"]').forEach((b) => b.addEventListener('click', () => { replaceTarget = Number(b.dataset.id); file.click(); }));
    body.querySelectorAll('[data-a="history"]').forEach((b) => b.addEventListener('click', async () => {
      const hist = await attachmentHistory(byId[b.dataset.id]).catch(() => []);
      const target = body.querySelector('[data-a="hist"]');
      target.innerHTML = `<div class="sc-card" style="margin-top:8px"><div class="sc-card-h"><h3>🕓 Revision history — ${esc(byId[b.dataset.id].filename)}</h3></div>
        <table class="sc-table" style="min-width:0"><tbody>${hist.map((h) => `<tr>
          <td><span class="sc-badge ${h.superseded ? 'none' : 'confirmed'}">rev ${h.revision}${h.superseded ? '' : ' · current'}</span></td>
          <td style="font-size:12px">${esc(h.filename)}</td><td style="font-size:11.5px">${fmtSize(h.byte_size)}</td>
          <td style="font-size:11.5px">${fmtWhen(h.created_at)} · ${esc(h.uploaded_by || '—')}</td>
          <td style="text-align:right"><button class="sc-btn sm ghost" data-h="${esc(h.storage_path)}" data-n="${esc(h.filename)}">⬇</button></td></tr>`).join('')}</tbody></table></div>`;
      target.querySelectorAll('[data-h]').forEach((x) => x.addEventListener('click', () => {
        window.open(attachmentUrl({ storage_path: x.dataset.h }) + '?download=' + encodeURIComponent(x.dataset.n), '_blank');
      }));
    }));

    async function handleFiles(files) {
      const list = [...files];
      if (replaceTarget && list.length > 1) { toast('Pick a single file when replacing', 'err'); return; }
      let ok = 0;
      for (const f of list) {
        try { await uploadAttachment(docType, docId, f, { replaceId: replaceTarget || undefined, actor }); ok++; }
        catch (e) { toast(e.message || String(e), 'err'); }
      }
      replaceTarget = null;
      if (ok) { toast(ok + ' file(s) uploaded', 'ok'); paintBody(); countAttachments(docType, docId).then((n) => { const c = el.querySelector('[data-a="count"]'); if (c) c.textContent = n; }).catch(() => {}); }
    }
  }

  shell();
}
