// Purchase Order status model — the document lifecycle.
export const ORDER_STATUS = {
  DRAFT: 'Draft',
  APPROVED: 'Approved',
  PI_IMPORTED: 'PI Imported',
  PI_APPROVED: 'PI Approved',
  CLOSED: 'Closed',
};

export const ORDER_STAGES = [
  ORDER_STATUS.DRAFT, ORDER_STATUS.APPROVED, ORDER_STATUS.PI_IMPORTED,
  ORDER_STATUS.PI_APPROVED, ORDER_STATUS.CLOSED,
];

export const ORDER_STATUS_VARIANT = {
  Draft: 'draft', Approved: 'approved', 'PI Imported': 'pi', 'PI Approved': 'approved', Closed: 'closed',
};

export const ORDER_STAGE_COLOR = {
  Draft: '#8FA3BD', Approved: '#2FB344', 'PI Imported': '#9775FA', 'PI Approved': '#22B8CF', Closed: '#F76707',
};

export const isEditable = (status) => status === ORDER_STATUS.DRAFT;
