// Proforma Invoice status model.
export const PI_STATUS = {
  IMPORTED: 'Imported',
  VALIDATION_REQUIRED: 'Validation Required',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

export const PI_STATUSES = [
  PI_STATUS.IMPORTED, PI_STATUS.VALIDATION_REQUIRED, PI_STATUS.APPROVED, PI_STATUS.REJECTED,
];

export const PI_STATUS_VARIANT = {
  Imported: 'pi', 'Validation Required': 'closed', Approved: 'confirmed', Rejected: 'draft',
};

// Per-line comparison outcome labels (used by the validation report).
export const LINE_RESULT = {
  matched: '✓ Match',
  qty_diff: '✗ Quantity',
  price_diff: '✗ Price',
  amount_diff: '✗ Amount',
  missing: '✗ Missing in PI',
  additional: '✗ Extra in PI',
};
