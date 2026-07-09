// Purchase Order status model — revision-based procurement lifecycle.
//   Draft → Approved → PI Imported → [Revision Required → Revision Applied] →
//   PI Approved → Ready for Shipment   (Closed is terminal/manual)
export const ORDER_STATUS = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  PI_IMPORTED: 'PI Imported',
  REVISION_REQUIRED: 'Revision Required',
  REVISION_APPLIED: 'Revision Applied',
  PI_APPROVED: 'PI Approved',
  READY_FOR_SHIPMENT: 'Ready for Shipment',
  CLOSED: 'Closed',
};

// Linear happy-path stages for the workflow pipeline display.
export const ORDER_STAGES = [
  ORDER_STATUS.DRAFT, ORDER_STATUS.APPROVED, ORDER_STATUS.PI_IMPORTED,
  ORDER_STATUS.REVISION_APPLIED, ORDER_STATUS.PI_APPROVED, ORDER_STATUS.READY_FOR_SHIPMENT,
];

export const ORDER_STATUS_VARIANT = {
  Draft: 'draft',
  Approved: 'approved',
  'PI Imported': 'pi',
  'Revision Required': 'closed',
  'Revision Applied': 'pi',
  'PI Approved': 'approved',
  'Ready for Shipment': 'confirmed',
  Closed: 'closed',
};

export const ORDER_STAGE_COLOR = {
  Draft: '#8FA3BD', Approved: '#2FB344', 'PI Imported': '#9775FA',
  'Revision Required': '#F76707', 'Revision Applied': '#CC5DE8',
  'PI Approved': '#22B8CF', 'Ready for Shipment': '#2FB344', Closed: '#F76707',
};

export const isEditable = (status) => status === ORDER_STATUS.DRAFT;
