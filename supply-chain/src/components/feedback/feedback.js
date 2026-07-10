// Global loading & process feedback — UI layer only, no business logic.
// One engine gives every screen the same behaviour:
//   · any [data-act]/[data-qact] handler that returns a Promise instantly puts
//     its button into a busy state (disabled + spinner + "Saving…" text) and
//     restores it when the work settles — one click can never fire twice;
//   · pageLoading()/pageLoadingDone() show a centered blocking overlay for
//     whole-page work (exports, modal-confirmed actions, heavy navigation);
//   · skeleton helpers render shimmer placeholders instead of empty tables,
//     cards and detail pages while data loads.
import { esc } from '../../utils/format.js';

export const spinner = (size = 13) =>
  `<span class="sc-spin" style="width:${size}px;height:${size}px" aria-hidden="true"></span>`;

// ---- busy text: data-busy attribute wins, then the action verb, then the
// button's own label, so "Approve" becomes "Approving…" without per-page code.
const ACT_LABELS = {
  save: 'Saving…', savepending: 'Saving…', savemap: 'Saving…', 'save-override': 'Saving…',
  'save-matched': 'Saving…', 'save-disputed': 'Saving…', apply: 'Applying…',
  approve: 'Approving…', confirm: 'Confirming…', creategr: 'Receiving…', receive: 'Receiving…',
  upload: 'Uploading…', reupload: 'Uploading…', import: 'Importing…', importxl: 'Importing…',
  parse: 'Reading…', xls: 'Exporting…', xlsall: 'Exporting…', export: 'Exporting…',
  bizfile: 'Exporting…', print: 'Preparing…', refresh: 'Refreshing…', rematch: 'Matching…',
  match: 'Matching…', matchflow: 'Matching…', dispatch: 'Dispatching…', ship: 'Dispatching…',
  close: 'Closing…', cancel: 'Cancelling…', delete: 'Deleting…', del: 'Deleting…',
  create: 'Creating…', new: 'Creating…', dup: 'Duplicating…', revise: 'Saving…',
  edit: 'Opening…', view: 'Opening…', open: 'Opening…', search: 'Searching…',
};
const VERB_MAP = [
  [/^save/i, 'Saving…'], [/^updat/i, 'Updating…'], [/^delet|^remove/i, 'Deleting…'],
  [/^approv/i, 'Approving…'], [/^confirm/i, 'Confirming…'], [/^receiv/i, 'Receiving…'],
  [/^match/i, 'Matching…'], [/^upload/i, 'Uploading…'], [/^import/i, 'Importing…'],
  [/^export|excel|business file/i, 'Exporting…'], [/^close/i, 'Closing…'],
  [/^cancel/i, 'Cancelling…'], [/^dispatch|^ship/i, 'Dispatching…'], [/^creat/i, 'Creating…'],
  [/^search/i, 'Searching…'], [/^refresh|^reload/i, 'Refreshing…'], [/^print/i, 'Preparing…'],
];
export function busyLabel(node) {
  if (node.dataset && node.dataset.busy) return node.dataset.busy;
  const act = node.dataset && (node.dataset.act || node.dataset.qact);
  if (act && ACT_LABELS[act]) return ACT_LABELS[act];
  const text = (node.textContent || '').trim();
  for (const [re, label] of VERB_MAP) if (re.test(text)) return label;
  return 'Processing…';
}

// ---- per-element busy state (spinner inside buttons, subtle lock elsewhere)
const BUSY = new WeakSet();
export function isBusy(node) { return BUSY.has(node); }

export function startBusy(node) {
  BUSY.add(node);
  const isButton = node.tagName === 'BUTTON' || /\bsc-btn\b|\bdoc-more-item\b/.test(node.className || '');
  const prev = { html: node.innerHTML, disabled: node.disabled, cls: node.className };
  node.classList.add('is-busy');
  node.setAttribute('aria-busy', 'true');
  if (isButton) {
    node.disabled = true;
    node.innerHTML = `${spinner()} ${esc(busyLabel(node))}`;
  }
  let done = false;
  return () => {
    if (done) return; done = true;
    BUSY.delete(node);
    // the view may have re-rendered and replaced the node — restoring a
    // detached element is a harmless no-op
    if (isButton) { node.innerHTML = prev.html; node.disabled = prev.disabled; }
    node.className = prev.cls;
    node.removeAttribute('aria-busy');
  };
}

// Run a click handler with the standard feedback contract: ignore clicks while
// the element is busy; if the handler is async, show the busy state until it
// settles. Errors keep propagating to the handler's own toast/catch logic.
// The snapshot is taken BEFORE the handler runs, so handlers that repaint the
// button themselves still end on their own final state, never on ours.
export function runAction(fn, dataset, node, event) {
  if (BUSY.has(node)) return;
  const restore = startBusy(node);
  let out;
  try { out = fn(dataset, node, event); }
  catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') out.then(restore, restore);
  else restore();   // synchronous action — no spinner ever painted
  return out;
}

// ---- full-page blocking overlay (reference-counted) --------------------
let overlay = null, overlayCount = 0;
export function pageLoading(message = 'Please wait…') {
  overlayCount++;
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'sc-page-loading';
    overlay.innerHTML = `<div class="sc-page-loading-box">${spinner(22)}<span data-el="msg"></span></div>`;
    document.body.appendChild(overlay);
  }
  overlay.querySelector('[data-el="msg"]').textContent = message;
  overlay.classList.add('open');
  return pageLoadingDone;
}
export function pageLoadingDone() {
  overlayCount = Math.max(0, overlayCount - 1);
  if (overlay && overlayCount === 0) overlay.classList.remove('open');
}
// Convenience: overlay around a promise — for modal-confirmed and whole-page work.
export async function withPageLoading(message, work) {
  pageLoading(message);
  try { return await work(); } finally { pageLoadingDone(); }
}

// ---- skeleton placeholders ---------------------------------------------
const skLine = (w) => `<div class="sk sk-line" style="width:${w}"></div>`;

export function skeletonTable(cols = 6, rows = 7) {
  const head = Array.from({ length: cols }, () => `<th>${skLine('70%')}</th>`).join('');
  const body = Array.from({ length: rows }, () =>
    `<tr>${Array.from({ length: cols }, (_, i) => `<td>${skLine(i === 1 ? '85%' : '60%')}</td>`).join('')}</tr>`).join('');
  return `<div class="sc-table-wrap"><table class="sc-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function skeletonCards(n = 4) {
  return `<div class="sk-cards">${Array.from({ length: n }, () =>
    `<div class="sc-card sk-card">${skLine('40%')}${skLine('75%')}${skLine('55%')}</div>`).join('')}</div>`;
}

// Whole-page placeholder: header bar + KPI cards + table — used while a page
// (or a heavy detail view) loads, with the message announced for screen readers.
export function skeletonPage(message = 'Loading…') {
  return `<div class="sk-page" role="status" aria-live="polite">
    <div class="sk-page-head">${spinner()} <span>${esc(message)}</span></div>
    <div class="sc-card" style="margin-bottom:14px">${skLine('30%')}${skLine('60%')}</div>
    ${skeletonCards(4)}
    <div class="sc-card">${skeletonTable(6, 7)}</div>
  </div>`;
}
