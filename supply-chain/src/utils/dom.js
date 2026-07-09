// Tiny DOM helpers — keep pages framework-free but declarative.

export const el = (id) => document.getElementById(id);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function mount(root, html) {
  root.innerHTML = html;
  return root;
}

// Event delegation: elements carry data-act="name"; handlers[name](dataset, elem, event).
export function delegate(root, handlers) {
  root.addEventListener('click', (e) => {
    const target = e.target.closest('[data-act]');
    if (!target || !root.contains(target)) return;
    const fn = handlers[target.dataset.act];
    if (fn) { e.preventDefault(); fn(target.dataset, target, e); }
  });
}

// Wire click handlers to the [data-act] elements currently in root (no
// delegation) — safe to call after every re-render, no listener stacking.
export function wire(root, handlers) {
  root.querySelectorAll('[data-act]').forEach((node) => {
    const fn = handlers[node.dataset.act];
    if (fn) node.addEventListener('click', (e) => { e.preventDefault(); fn(node.dataset, node, e); });
  });
}

// Attach an input listener to every [data-input="name"] under root.
export function onInput(root, name, fn) {
  qsa(`[data-input="${name}"]`, root).forEach((node) =>
    node.addEventListener('input', (e) => fn(e.target.value, e.target, e)));
}
