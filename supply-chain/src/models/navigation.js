// Navigation model — the ERP module map. Modules not part of the current
// purchasing workflow are kept here (routes stay reachable) but flagged
// `hidden: true` so they don't appear in the sidebar until we start on them.
export const NAV = [
  { group: 'Overview', items: [{ id: 'dashboard', icon: '📊', label: 'Dashboard' }] },
  { group: 'Procurement', items: [
    { id: 'sku-master', icon: '🧾', label: 'SKU Master' },
    { id: 'purchase-orders', icon: '🛒', label: 'Purchase Invoices' },
    { id: 'open-orders', icon: '⏳', label: 'Open Orders' },
    { id: 'order-history', icon: '📋', label: 'PI History' },
  ] },
  { group: 'Supplier Documents', items: [
    { id: 'pi-import', icon: '📥', label: 'PI Import' },
    { id: 'validation', icon: '✅', label: 'PI Validation' },
    { id: 'workflow', icon: '🔀', label: 'Workflow', hidden: true },
    { id: 'supplier-invoices', icon: '🧾', label: 'Supplier Invoices' },
  ] },
  { group: 'Logistics', items: [
    { id: 'delivery-notes', icon: '🚚', label: 'Delivery Notes' },
    { id: 'shipment', icon: '🛫', label: 'Shipment' },
    { id: 'goods-receiving', icon: '📦', label: 'Warehouse Receiving' },
    { id: 'inventory', icon: '🏬', label: 'Inventory', hidden: true },
    { id: 'batch-tracking', icon: '🔖', label: 'Batch Tracking', hidden: true },
    { id: 'expiry', icon: '⏳', label: 'Expiry Management', hidden: true },
    { id: 'returns-supplier', icon: '↩️', label: 'Returns to Supplier', hidden: true },
    { id: 'claims', icon: '📑', label: 'Claims', hidden: true },
  ] },
  { group: 'System', items: [
    { id: 'reports', icon: '📈', label: 'Reports', hidden: true },
    // Settings lives under the user/profile menu in the top bar, not the sidebar.
    { id: 'settings', icon: '⚙️', label: 'Settings', hidden: true },
  ] },
];

export const NAV_ITEMS = NAV.flatMap((g) => g.items);
export const isSection = (id) => NAV_ITEMS.some((i) => i.id === id);
export const labelOf = (id) => (NAV_ITEMS.find((i) => i.id === id) || {}).label || 'Supply Chain';
export const iconOf = (id) => (NAV_ITEMS.find((i) => i.id === id) || {}).icon || '🧩';
export const isHidden = (id) => !!(NAV_ITEMS.find((i) => i.id === id) || {}).hidden;
