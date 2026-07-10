// SINGLE SOURCE OF TRUTH for the BUSINESS status of every document.
//
// The workflow keeps its detailed internal states (they drive the gates:
// receivable statuses, invoice matching, QC, inventory posting — none of
// that changes). Every screen translates those states into the one business
// vocabulary through THIS module, so Purchase Orders, Open Orders, Delivery
// Notes, Shipments, Warehouse Receiving, Supplier Invoices, Purchase History,
// Dashboard and Search always show the same status:
//
//   Draft → Approved → Shipped → Delivered            (happy path)
//   Draft → Approved [→ Shipped] → Closed             (manual close)
//
//   - PI approved                        → Approved
//   - Delivery Note confirmed/dispatched → Shipped
//   - Invoice matched & receipt posted   → Delivered
//   - Manual "Close Purchase Order"      → Closed (remaining qty Cancelled)

// ---- Delivery Notes -------------------------------------------------------
// A DN counts as SHIPPED once its shipment is confirmed (dispatched or already
// at the warehouse door), and DELIVERED once the warehouse receipt posted.
export const DN_SHIPPED_STATUSES = ['In Transit', 'Receiving Review'];
export const DN_DELIVERED_STATUSES = ['Received'];

export const dnBusinessStatus = (dnStatus) => {
  if (DN_DELIVERED_STATUSES.includes(dnStatus)) return 'Delivered';
  if (DN_SHIPPED_STATUSES.includes(dnStatus)) return 'Shipped';
  return dnStatus; // Imported / Approved / Ready for Delivery / Disputed / Cancelled …
};

// ---- Purchase-order lines -------------------------------------------------
// Line status derives from quantities only: ordered vs shipped (cases on
// confirmed DNs, including already-received ones) vs delivered (cases posted
// into the warehouse). `closed` marks a manually closed PO: whatever was not
// delivered is Cancelled, never silently "Delivered".
export function lineBusinessStatus({ ordered = 0, shipped = 0, delivered = 0 }, { closed = false } = {}) {
  const o = Number(ordered) || 0, s = Number(shipped) || 0, d = Number(delivered) || 0;
  if (d >= o && o > 0) return 'Delivered';
  if (closed) return d > 0 ? 'Partially Delivered · rest Cancelled' : 'Cancelled';
  if (d > 0) return 'Partially Delivered';
  if (s >= o && o > 0) return 'Shipped';
  if (s > 0) return 'Partially Shipped';
  return 'Approved';
}

// ---- Purchase order (headline) --------------------------------------------
// order: the supply_orders row (status + close_reason at minimum)
// agg:    { ordered, shipped, delivered } summed over the lines (optional —
//         without it the stored status alone decides, which is exact for
//         Draft / pre-shipment / terminal states)
export function orderBusinessStatus(order, agg) {
  if (!order) return '—';
  const s = order.status;
  if (s === 'Draft' || s === 'Revision Required' || s === 'Revision Applied') return 'Draft';
  if (s === 'Financially Closed') return 'Financially Closed';
  // Closed with a close reason = manually closed before completion;
  // Closed without one = auto-closed because every line was received.
  if (s === 'Closed') return order.close_reason ? 'Closed' : 'Delivered';
  if (agg) {
    const o = Number(agg.ordered) || 0, sh = Number(agg.shipped) || 0, d = Number(agg.delivered) || 0;
    if (o > 0 && d >= o) return 'Delivered';
    if (d > 0) return 'Partially Delivered';
    if (o > 0 && sh >= o) return 'Shipped';
    if (sh > 0) return 'Partially Shipped';
    return 'Approved';
  }
  // stored fulfillment statuses, translated
  if (s === 'Partially Received') return 'Partially Delivered';
  if (s === 'Fully Received' || s === 'Invoice Matched') return 'Delivered';
  if (s === 'Partially Delivered') return 'Partially Shipped';
  if (s === 'Fully Delivered' || s === 'Ready for Shipment') return 'Shipped';
  return 'Approved'; // Approved / PI Imported / PI Approved
}

// ---- Supplier invoice -----------------------------------------------------
// A matched invoice whose delivery has been posted to the warehouse is the
// financially DELIVERED document; before posting it stays Matched.
export function siBusinessStatus(siStatus, dnStatus) {
  if (siStatus === 'Matched' && dnStatus && DN_DELIVERED_STATUSES.includes(dnStatus)) return 'Delivered';
  return siStatus;
}

// badge CSS variant for the business vocabulary (matches .sc-badge classes)
export const BIZ_VARIANT = {
  Draft: 'draft', Approved: 'approved',
  Shipped: 'pi', 'Partially Shipped': 'pi',
  Delivered: 'confirmed', 'Partially Delivered': 'pi',
  Closed: 'closed', Cancelled: 'closed', 'Financially Closed': 'confirmed',
};

// standard reasons for manually closing a purchase order (mandatory pick)
export const CLOSE_REASONS = [
  'Supplier cannot complete delivery',
  'Supplier cancelled the order',
  'Customer request',
  'Price changed',
  'Replaced by a new Purchase Order',
  'Duplicate Purchase Order',
  'Other',
];

// orders in these stored states cannot take new DNs / invoices and never
// appear in Open Orders
export const ORDER_TERMINAL_STATUSES = ['Closed', 'Financially Closed'];
export const isOrderClosed = (order) => !!order && ORDER_TERMINAL_STATUSES.includes(order.status);
// manual close is offered only while the order is not fully delivered
export const canCloseManually = (order) => !!order && !isOrderClosed(order) && order.status !== 'Draft';
