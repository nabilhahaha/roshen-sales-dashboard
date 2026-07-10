// Fulfillment / receiving status vocabularies for the Delivery Note module.
// Operational completion (delivery/receipt) and financial completion (invoice
// match / financial closure) are tracked separately — see db/DESIGN.md.

export const DN_STATUS = {
  IMPORTED: 'Imported',
  RECEIVING_REVIEW: 'Receiving Review',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled',
};

export const SI_STATUS = {
  IMPORTED: 'Imported',
  MATCHED: 'Matched',
  DISPUTED: 'Disputed',
  CANCELLED: 'Cancelled',
};

export const GR_STATUS = {
  PENDING_QC: 'Pending QC',
  PARTIALLY_RELEASED: 'Partially Released',
  RELEASED: 'Released',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
};

// Per-batch QC (delivery-note batch + goods-receipt batch)
export const QC = {
  PENDING: 'Pending QC',
  RELEASED: 'Released',
  REJECTED: 'Rejected',
};

// Purchase-order fulfillment statuses added by migration 002.
export const PO_FULFILLMENT = {
  PARTIALLY_DELIVERED: 'Partially Delivered',
  FULLY_DELIVERED: 'Fully Delivered',
  PARTIALLY_RECEIVED: 'Partially Received',
  FULLY_RECEIVED: 'Fully Received',
  INVOICE_MATCHED: 'Invoice Matched',
  FINANCIALLY_CLOSED: 'Financially Closed',
};

// Badge variant (maps to existing .sc-badge classes) for each status value.
// Business-facing display names for stored status values (display only —
// the stored values and the workflow never change).
export const STATUS_DISPLAY = {
  Imported: 'New',
  'Receiving Review': 'Being Received',
  'Partially Released': 'Partly Released',
};

export const STATUS_VARIANT = {
  // DN
  Imported: 'pi', 'Ready for Delivery': 'approved', 'In Transit': 'pi', 'Receiving Review': 'closed', Received: 'confirmed', Cancelled: 'draft', Reversed: 'draft', Draft: 'draft',
  // SI
  Matched: 'confirmed', 'Partially Matched': 'pi', Disputed: 'closed', Replaced: 'draft',
  // GR / QC
  'Pending QC': 'closed', 'Partially Released': 'pi', Released: 'confirmed', Rejected: 'draft',
  // PO fulfillment
  'Partially Delivered': 'pi', 'Fully Delivered': 'pi',
  'Partially Received': 'pi', 'Fully Received': 'confirmed',
  'Invoice Matched': 'approved', 'Financially Closed': 'confirmed',
};

export const QC_COLOR = {
  'Pending QC': '#F2C037', Released: '#2FB344', Rejected: '#E03131',
};
