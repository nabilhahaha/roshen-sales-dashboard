// Navigation model — the sidebar mirrors the real purchasing workflow, in
// order: SKU Master → Purchase Orders → Open Orders → Delivery Notes →
// Warehouse Receiving → Supplier Invoices → Purchase History.
//
// Everything else is flagged `hidden: true`: the route (and page) stays fully
// reachable — for in-workflow navigation (PI Import / PI Validation open from
// inside Purchase Orders) and deep links — it just never appears as a menu
// item. Nothing is deleted.
export const NAV = [
  { group: 'Overview', items: [
    // Executive Procurement Dashboard — management overview; the working
    // landing page stays Purchase Orders.
    { id: 'dashboard', icon: '📊', label: 'Dashboard' },
  ] },
  { group: 'Procurement', items: [
    { id: 'sku-master', icon: '🧾', label: 'SKU Master' },
    { id: 'purchase-orders', icon: '🛒', label: 'Purchase Orders' },
    { id: 'open-orders', icon: '⏳', label: 'Open Orders' },
    // reachable from inside the Purchase Order workflow, not the sidebar
    { id: 'pi-import', icon: '📥', label: 'PI Import', hidden: true },
    { id: 'validation', icon: '✅', label: 'PI Validation', hidden: true },
  ] },
  { group: 'Logistics', items: [
    { id: 'delivery-notes', icon: '🚚', label: 'Delivery Notes' },
    // live shipment stage (Ready for Delivery / In Transit / ETA) — part of
    // the warehouse workflow, so it stays visible with a real board.
    { id: 'shipment', icon: '🛫', label: 'Shipments' },
    { id: 'goods-receiving', icon: '📦', label: 'Warehouse Receiving' },
    { id: 'inventory', icon: '🏬', label: 'Inventory', hidden: true },
    { id: 'batch-tracking', icon: '🔖', label: 'Batch Tracking', hidden: true },
    { id: 'expiry', icon: '⏳', label: 'Expiry Management', hidden: true },
    { id: 'returns-supplier', icon: '↩️', label: 'Returns to Supplier', hidden: true },
    { id: 'claims', icon: '📑', label: 'Claims', hidden: true },
  ] },
  { group: 'Financial', items: [
    { id: 'supplier-invoices', icon: '🧾', label: 'Supplier Invoices' },
  ] },
  { group: 'History', items: [
    { id: 'order-history', icon: '📋', label: 'Purchase History' },
  ] },
  { group: 'System', items: [
    { id: 'workflow', icon: '🔀', label: 'Workflow', hidden: true },
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
