// Lazy attachments panel — reusable for PI / Delivery Note / Supplier Invoice.
//
// Renders collapsed (a header with a lazy count); NOTHING else is fetched
// until the user expands it. Files upload straight to Supabase Storage
// (drag-and-drop or file picker, multiple at once, any supported format);
// the list shows metadata only; preview/download stream from storage on
// demand. Replace uploads a new revision and keeps the old one in history.
import { esc } from '../../utils/format.js';
import { toast } from '../notifications/toast.js';
import {
  listAttachments, countAttachments, uploadAttachment, attachmentUrl,
  attachmentHistory, canPreview, kindOf, ACCEPT_ATTR,
} from '../../services/attachments/attachments.service.js';

const ICON = { pdf: '📄', image: '🖼', sheet: '📊' };
const fmtSize = (b) => (b == null ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtWhen = (t) => esc(String(t || '').slice(0, 16).replace('T', ' '));

// attachmentsPanel(el, 'purchase_order', 42, { actor })
export function attachmentsPanel(el, docType, docId, { actor = 'Development' } = {}) {
  let expanded = false;
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

    body.querySelectorAll('[data-a="preview"]').forEach((b) => b.addEventListener('click', () => window.open(attachmentUrl(byId[b.dataset.id]), '_blank')));
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
