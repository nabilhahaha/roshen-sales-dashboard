// Shared V2 document pieces used by every detail page:
//   - attachment preview inside an in-page drawer (never leave the screen)
//   - the "Documents" tab (own attachments + the chain's originals)
//   - the "Business File" drawer: the whole connected transaction in one place
//     (document chain → attachments → timeline → audit), no navigation needed
import { esc } from '../../utils/format.js';
import { openDrawer } from './document-shell.js';
import { attachmentsPanel, previewAttachment } from '../attachments/attachments-panel.js';
import { renderDocumentChain } from '../related/document-chain.js';
import { listChainAttachments, attachmentUrl, kindOf, canPreview } from '../../services/attachments/attachments.service.js';
import { buildBusinessTimeline } from '../../services/timeline/business-timeline.service.js';

const ICON = { pdf: '📄', image: '🖼', sheet: '📊' };
const when = (t) => esc(String(t || '').slice(0, 16).replace('T', ' '));
export { previewAttachment };

// the chain's original files as a grid (referenced, never duplicated) — used
// on the Documents tab of every page and inside the Business File drawer
export async function chainFilesGrid(orderId, { title = '🔗 Originals from the document chain' } = {}) {
  let atts = [];
  try { atts = await listChainAttachments(orderId); } catch (e) { atts = []; }
  if (!atts.length) return '';
  return `<div class="sc-card"><div class="sc-card-h"><h3>${title}</h3>
      <span class="sc-badge none" style="margin-left:8px">${atts.length}</span><div class="sc-spacer"></div>
      <span style="font-size:11px;color:var(--text-muted)">same files, referenced across every related document</span></div>
    <div class="sc-table-wrap"><table class="sc-table"><thead><tr><th>Document</th><th>File</th><th>Uploaded</th><th>By</th><th>Ver</th><th></th></tr></thead><tbody>
    ${atts.map((a, i) => `<tr>
      <td style="font-size:12px">${esc(a.doc_label)}</td>
      <td>${ICON[kindOf(a.mime || a.filename)] || '📎'} <b style="font-size:12px">${esc(a.filename)}</b></td>
      <td style="font-size:11.5px">${when(a.created_at)}</td>
      <td style="font-size:11.5px">${esc(a.uploaded_by || '—')}</td>
      <td style="font-size:11.5px">${a.revision || 1}</td>
      <td style="text-align:right;white-space:nowrap">
        ${canPreview(a) ? `<button class="sc-btn sm ghost" data-chainprev="${i}">👁 Preview</button>` : ''}
        <button class="sc-btn sm ghost" data-chaindl="${i}">⬇</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
export function wireChainFilesGrid(el, orderId) {
  listChainAttachments(orderId).then((atts) => {
    const previewable = atts.filter((a) => canPreview(a));
    el.querySelectorAll('[data-chainprev]').forEach((b) => b.addEventListener('click', () => {
      const a = atts[+b.dataset.chainprev];
      previewAttachment(a, { list: previewable, index: Math.max(0, previewable.indexOf(a)) });
    }));
    el.querySelectorAll('[data-chaindl]').forEach((b) => b.addEventListener('click', () => {
      const a = atts[+b.dataset.chaindl];
      const link = document.createElement('a');
      link.href = attachmentUrl(a) + '?download=' + encodeURIComponent(a.filename);
      link.download = a.filename; document.body.appendChild(link); link.click(); link.remove();
    }));
  }).catch(() => {});
}

// the standard "Documents" tab: own attachments (upload/replace/history) +
// every original from the chain — all in place
export async function renderDocumentsTab(el, { docType, docId, orderId, actor }) {
  el.innerHTML = '<div data-x="own"></div><div data-x="chain"></div>';
  if (docType && docId) attachmentsPanel(el.querySelector('[data-x="own"]'), docType, docId, { actor });
  if (orderId) {
    const host = el.querySelector('[data-x="chain"]');
    host.innerHTML = await chainFilesGrid(orderId);
    wireChainFilesGrid(host, orderId);
  }
}

// the standard "Timeline" tab: business journey + (optional) raw audit html
export async function renderTimelineTab(el, orderId, extraHtml = '') {
  let events = [];
  try { events = await buildBusinessTimeline(orderId); } catch (e) { events = []; }
  el.innerHTML = `<div class="sc-card"><div class="sc-card-h"><h3>🧭 Business Timeline</h3><div class="sc-spacer"></div>
      <span class="sc-badge none">${events.length}</span></div>
    ${events.length ? `<div class="erp-rev-timeline">${events.map((e) => `<div class="erp-rev">
      <div class="erp-rev-h"><b>${e.icon} ${esc(e.label)}</b>
      <span style="margin-left:auto;font-size:11px;color:var(--text-muted)">${esc(e.user || '—')} · ${when(e.at)}</span></div></div>`).join('')}</div>`
      : '<p style="font-size:12px;color:var(--text-muted);margin:0">No events yet.</p>'}</div>${extraHtml}`;
}

// Business File — one drawer with the ENTIRE connected transaction
export async function openBusinessFile(orderId, navigate) {
  const body = openDrawer('📁 Business File — the complete transaction', '<p style="font-size:12px;color:var(--text-muted)">Loading…</p>');
  body.innerHTML = '<div data-x="chain"></div><div data-x="files"></div><div data-x="tl"></div>';
  await renderDocumentChain(body.querySelector('[data-x="chain"]'), navigate, { orderId, current: {} });
  const filesHost = body.querySelector('[data-x="files"]');
  filesHost.innerHTML = await chainFilesGrid(orderId, { title: '📎 Attachments' });
  wireChainFilesGrid(filesHost, orderId);
  await renderTimelineTab(body.querySelector('[data-x="tl"]'), orderId);
}
