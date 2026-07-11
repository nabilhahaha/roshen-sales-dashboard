// Roshen Supply Chain — application bootstrap + router.
// Pages are rendered into the shell's content area; each page receives a fresh
// node and a ctx = { navigate, params, section, setNotif }.
import { renderShell } from './components/layout/layout.js';
import { attachGlobalSearch } from './components/search/global-search.js';
import { isSection } from './models/navigation.js';

import * as dashboard from './pages/dashboard/dashboard.page.js';
import * as skuMaster from './pages/sku-master/sku-master.page.js';
import * as purchaseOrders from './pages/purchase-orders/purchase-orders.page.js';
import * as orderHistory from './pages/order-history/order-history.page.js';
import * as openOrders from './pages/open-orders/open-orders.page.js';
import * as businessFiles from './pages/business-files/business-files.page.js';
import * as piImport from './pages/pi-import/pi-import.page.js';
import * as validation from './pages/validation/validation.page.js';
import * as workflow from './pages/workflow/workflow.page.js';
import * as importOrder from './pages/purchase-orders/import/import-order.page.js';
import * as poRevision from './pages/purchase-orders/revision/revision.page.js';
import * as supplierInvoices from './pages/supplier-invoices/supplier-invoices.page.js';
import * as deliveryNotes from './pages/delivery-notes/delivery-notes.page.js';
import * as goodsReceiving from './pages/goods-receiving/goods-receiving.page.js';
import * as inventory from './pages/inventory/inventory.page.js';
import * as batchTracking from './pages/batch-tracking/batch-tracking.page.js';
import * as shipment from './pages/shipment/shipment.page.js';
import * as placeholder from './pages/placeholder.page.js';

const PAGES = {
  dashboard,
  'sku-master': skuMaster,
  'purchase-orders': purchaseOrders,
  'order-history': orderHistory,
  'open-orders': openOrders,
  'business-files': businessFiles,
  'import-order': importOrder,
  'po-revision': poRevision,
  'pi-import': piImport,
  validation,
  workflow,
  'supplier-invoices': supplierInvoices,
  'delivery-notes': deliveryNotes,
  'goods-receiving': goodsReceiving,
  inventory,
  'batch-tracking': batchTracking,
  shipment,
};

// routes reachable by the router but not shown as sidebar items
const EXTRA_ROUTES = { 'import-order': 'purchase-orders', 'po-revision': 'purchase-orders' };

let shell = null;
let currentCtx = null;

function navigate(section, params) {
  // Purchase Orders is the master document and the workflow's starting point.
  if (!isSection(section) && !PAGES[section]) section = 'purchase-orders';
  shell.setActive(EXTRA_ROUTES[section] || section);
  // deep-linkable sub-path, e.g. #business-files/KS-393-2026 (pages may also
  // refine the hash themselves once they resolve their document)
  const sub = params && params.hashPath ? '/' + params.hashPath : '';
  try { history.replaceState(null, '', '#' + section + sub); } catch (e) {}

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
  // the global-search dropdown handles cross-module results; typing also
  // keeps filtering the current list when the page supports it
  if (currentCtx && typeof currentCtx.pageSearch === 'function') currentCtx.pageSearch(q);
}

function boot() {
  const app = document.getElementById('app');
  shell = renderShell(app, { onNavigate: navigate, onSearch });
  attachGlobalSearch(app.querySelector('.erp-topbar [data-el="search"]'), navigate);
  // Ctrl+F / Cmd+F focuses the global search (Esc returns to the browser default)
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      const s2 = app.querySelector('.erp-topbar [data-el="search"]');
      if (s2) { e.preventDefault(); s2.focus(); s2.select(); }
    }
  });
  const raw = (location.hash || '').replace('#', '');
  const [initial, ...rest] = raw.split('/');
  navigate(isSection(initial) ? initial : 'purchase-orders',
    rest.length ? { path: decodeURIComponent(rest.join('/')) } : undefined);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
