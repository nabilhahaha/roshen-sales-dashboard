// Roshen Supply Chain — application bootstrap + router.
// Pages are rendered into the shell's content area; each page receives a fresh
// node and a ctx = { navigate, params, section, setNotif }.
import { renderShell } from './components/layout/layout.js';
import { isSection } from './models/navigation.js';

import * as dashboard from './pages/dashboard/dashboard.page.js';
import * as skuMaster from './pages/sku-master/sku-master.page.js';
import * as purchaseOrders from './pages/purchase-orders/purchase-orders.page.js';
import * as orderHistory from './pages/order-history/order-history.page.js';
import * as piImport from './pages/pi-import/pi-import.page.js';
import * as validation from './pages/validation/validation.page.js';
import * as workflow from './pages/workflow/workflow.page.js';
import * as importOrder from './pages/purchase-orders/import/import-order.page.js';
import * as placeholder from './pages/placeholder.page.js';

const PAGES = {
  dashboard,
  'sku-master': skuMaster,
  'purchase-orders': purchaseOrders,
  'order-history': orderHistory,
  'import-order': importOrder,
  'pi-import': piImport,
  validation,
  workflow,
};

// routes reachable by the router but not shown as sidebar items
const EXTRA_ROUTES = { 'import-order': 'purchase-orders' };

let shell = null;
let currentCtx = null;

function navigate(section, params) {
  if (!isSection(section) && !PAGES[section]) section = 'dashboard';
  shell.setActive(EXTRA_ROUTES[section] || section);
  try { history.replaceState(null, '', '#' + section); } catch (e) {}

  const view = document.createElement('div');
  view.className = 'erp-view';
  shell.content.replaceChildren(view);

  const ctx = { navigate, params: params || {}, section, setNotif: shell.setNotif };
  currentCtx = ctx;

  const page = PAGES[section];
  try {
    if (page && page.render) page.render(view, ctx);
    else placeholder.render(view, ctx);
  } catch (e) {
    view.innerHTML = `<div class="sc-empty"><div class="ic">⚠</div><p>${(e && e.message) || e}</p></div>`;
    /* eslint-disable no-console */ console.error(e);
  }
  try { window.scrollTo({ top: 0 }); } catch (e) {}
}

function onSearch(q) {
  if (currentCtx && typeof currentCtx.pageSearch === 'function') { currentCtx.pageSearch(q); return; }
  if (q && q.trim()) navigate('sku-master', { q });
}

function boot() {
  const app = document.getElementById('app');
  shell = renderShell(app, { onNavigate: navigate, onSearch });
  const initial = (location.hash || '').replace('#', '');
  navigate(isSection(initial) ? initial : 'dashboard');
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
