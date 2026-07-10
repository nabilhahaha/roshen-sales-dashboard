// Reusable confirmation modal.
import { pageLoading, pageLoadingDone, busyLabel } from '../feedback/feedback.js';
let overlay = null;
function ensure() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'sc-modal-overlay';
  overlay.innerHTML =
    '<div class="sc-modal"><h4 data-el="title"></h4><p data-el="body"></p><div class="sc-modal-actions" data-el="actions"></div></div>';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.body.appendChild(overlay);
  return overlay;
}

export function close() { if (overlay) overlay.classList.remove('open'); }

// buttons: [{ label, cls, onClick }]
export function modal(title, bodyHtml, buttons = []) {
  const o = ensure();
  o.querySelector('[data-el="title"]').textContent = title;
  o.querySelector('[data-el="body"]').innerHTML = bodyHtml;
  const acts = o.querySelector('[data-el="actions"]');
  acts.innerHTML = '';
  buttons.forEach((b) => {
    const btn = document.createElement('button');
    btn.className = 'sc-btn ' + (b.cls || '');
    btn.textContent = b.label;
    btn.onclick = () => {
      close();
      if (!b.onClick) return;
      // a confirmed action that returns a Promise blocks the page with the
      // standard loading overlay until it settles — no wondering, no re-click
      const out = b.onClick();
      if (out && typeof out.then === 'function') {
        pageLoading(b.busy || busyLabel(btn));
        out.then(pageLoadingDone, pageLoadingDone);
      }
    };
    acts.appendChild(btn);
  });
  o.classList.add('open');
}
