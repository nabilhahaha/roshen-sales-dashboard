// Tiny DOM helpers — keep pages framework-free but declarative.
import { runAction } from '../components/feedback/feedback.js';

export const el = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Mobile card lists: tables marked .sc-cardify collapse into stacked cards on
// phones (CSS-only). Each td needs its column label — stamped here, centrally,
// from the table's own thead, so no page repeats its headers.
export function stampCardLabels(root) {
  root.querySelectorAll('table.sc-cardify').forEach((t) => {
    if (!t.tHead) return;
    const labels = [...t.tHead.querySelectorAll('th')].map((h) => h.textContent.trim());
    [...t.tBodies].forEach((tb) => [...tb.rows].forEach((tr) => {
      if (tr.cells.length < 2) return; // full-width detail rows keep their layout
      [...tr.cells].forEach((td, i) => { if (labels[i]) td.dataset.th = labels[i]; });
    }));
  });
  return root;
}

export function mount(root, html) {
  root.innerHTML = html;
  stampCardLabels(root);
  return root;
}

// Event delegation: elements carry data-act="name"; handlers[name](dataset, elem, event).
// Async handlers automatically get the standard busy feedback (button disabled
// + spinner + label) and double-click protection via runAction.
export function delegate(root, handlers) {
  root.addEventListener('click', (e) => {
    const target = e.target.closest('[data-act]');
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.act];
    if (fn) { e.preventDefault(); runAction(fn, target.dataset, target, e); }
  });
}

// Wire click handlers to the [data-act] elements currently in root (no
// delegation) — safe to call after every re-render, no listener stacking.
export function wire(root, handlers) {
  root.querySelectorAll('[data-act]').forEach((node) => {
    const fn = handlers[node.dataset.act];
    if (fn) node.addEventListener('click', (e) => { e.preventDefault(); runAction(fn, node.dataset, node, e); });
  });
}

// Attach an input listener to every [data-input="name"] under root.
export function onInput(root, name, fn) {
  qsa(`[data-input="${name}"]`, root).forEach((node) =>
    node.addEventListener('input', (e) => fn(e.target.value, e.target, e)));
}
