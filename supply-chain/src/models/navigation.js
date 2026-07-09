// Navigation model — the ERP module map. Active modules + reserved future ones.
export const NAV = [
  { group: 'Overview', items: [{ id: 'dashboard', icon: '📊', label: 'Dashboard' }] },
  { group: 'Procurement', items: [
    { id: 'sku-master', icon: '🧾', label: 'SKU Master' },
    { id: 'purchase-orders', icon: '🛒', label: 'Purchase Orders' },
    { id: 'order-history', icon: '📋', label: 'Order History' },
  ] },
  { group: 'Supplier Documents', items: [
    { id: 'pi-import', icon: '📥', label: 'PI Import' },
    { id: 'validation', icon: '✅', label: 'PI Validation' },
    { id: 'workflow', icon: '🔀', label: 'Workflow' },
    { id: 'supplier-invoices', icon: '🧾', label: 'Supplier Invoices' },
  ] },
  { group: 'Logistics', items: [
    { id: 'delivery-notes', icon: '🚚', label: 'Delivery Notes' },
    { id: 'goods-receiving', icon: '📦', label: 'Goods Receiving' },
    { id: 'inventory', icon: '🏬', label: 'Inventory' },
    { id: 'shipment', icon: '🛫', label: 'Shipment', soon: true },
    { id: 'batch-tracking', icon: '🔖', label: 'Batch Tracking' },
    { id: 'expiry', icon: '⏳', label: 'Expiry Management', soon: true },
    { id: 'returns-supplier', icon: '↩️', label: 'Returns to Supplier', soon: true },
    { id: 'claims', icon: '📑', label: 'Claims', soon: true },
  ] },
  { group: 'System', items: [
    { id: 'reports', icon: '📈', label: 'Reports', soon: true },
    { id: 'settings', icon: '⚙️', label: 'Settings', soon: true },
  ] },
];

export const NAV_ITEMS = NAV.flatMap((g) => g.items);
export const isSection = (id) => NAV_ITEMS.some((i) => i.id === id);
export const labelOf = (id) => (NAV_ITEMS.find((i) => i.id === id) || {}).label || 'Supply Chain';
export const iconOf = (id) => (NAV_ITEMS.find((i) => i.id === id) || {}).icon || '🧩';
export const isPlaceholder = (id) => !!(NAV_ITEMS.find((i) => i.id === id) || {}).soon;
