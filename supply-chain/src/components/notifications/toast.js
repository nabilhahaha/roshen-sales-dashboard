// Toast notifications.
import { esc } from '../../utils/format.js';

let container = null;
function ensure() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'sc-toast';
  document.body.appendChild(container);
  return container;
}

export function toast(message, type = 'info') {
  const c = ensure();
  const el = document.createElement('div');
  el.className = `sc-toast-item ${type}`;
  el.innerHTML = (type === 'ok' ? '✓ ' : type === 'err' ? '⚠ ' : 'ℹ ') + esc(message);
  c.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .4s, transform .4s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 400);
  }, 3400);
}
