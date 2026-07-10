// Receiving validation for a Delivery Note — PURE.
//
// For every physical batch on the DN, computes the live shelf-life figures
// (never stored) and the receiving decision against the SKU Master's own
// minimum-remaining-shelf-life %:
//
//   Remaining % >= Required %                     → 🟢 Accept
//   below Required %, within the approval band    → 🟡 Approval Required
//   deeper below, or expired                      → 🔴 Reject
//   % not computable (no expiry / no shelf life)  → 🟡 Approval Required
//
// No percentage is hardcoded: Required % comes from the SKU Master per SKU;
// the shelf-life math lives in models/shelf-life.js
// ((expiry − today) / (expiry − manufacturing), SKU total as fallback).
import { shelfLife } from '../../models/shelf-life.js';
import { lineKey as keyOf } from '../../utils/format.js';

// A below-minimum batch may still be received with a managerial exception when
// the shortfall is within this many percentage points of the SKU's minimum;
// a deeper shortfall is recommended for rejection. Workflow rule (not master
// data) — adjust here if the business changes the tolerance.
export const APPROVAL_BAND_PCT = 10;

export const DECISION = {
  accept: { code: 'accept', label: 'Accept', icon: '🟢', color: '#2FB344' },
  approval: { code: 'approval', label: 'Approval Required', icon: '🟡', color: '#F2C037' },
  reject: { code: 'reject', label: 'Reject', icon: '🔴', color: '#E03131' },
};

export function batchDecision(sl) {
  if (!sl || !sl.known || sl.remainingPct == null) return DECISION.approval; // can't verify → a human decides
  if (sl.expired) return DECISION.reject;
  if (sl.minPct == null) return sl.remainingPct != null ? DECISION.accept : DECISION.approval;
  if (sl.remainingPct >= sl.minPct) return DECISION.accept;
  if (sl.minPct - sl.remainingPct <= APPROVAL_BAND_PCT) return DECISION.approval;
  return DECISION.reject;
}

// dn: getDeliveryNote() shape (items[].batches[]); fulfillment: po_line_fulfillment
// rows for the order; skuFor: (line) => sku_master row | null.
// Returns one row per physical batch with every column of the receiving screen.
export function receivingValidation(dn, fulfillmentRows, skuFor, asOf) {
  const fulByKey = {};
  (fulfillmentRows || []).forEach((r) => { fulByKey[keyOf(r.roshen_id, r.item_code)] = r; });

  const rows = [];
  (dn.items || []).forEach((it) => {
    const sku = skuFor(it);
    const f = fulByKey[keyOf(it.roshen_id, it.item_code)] || null;
    (it.batches || []).forEach((b) => {
      const sl = shelfLife(sku, { expiry_date: b.expiry_date, manufacturing_date: b.manufacturing_date }, asOf);
      const decision = batchDecision(sl);
      rows.push({
        dn_item_id: it.id, dn_batch_id: b.id,
        sku_code: it.item_code || (sku && sku.item_code) || null,
        roshen_id: it.roshen_id || (sku && sku.roshen_id) || null,
        description: it.description || (sku && sku.item_description) || null,
        batch_no: b.batch_no || null,
        manufacturing_date: b.manufacturing_date || null,
        mfg_implied: !b.manufacturing_date && sl.known && sl.manufacturing ? sl.manufacturing : null,
        expiry_date: b.expiry_date || null,
        ordered_cases: f ? Number(f.ordered_cases || 0) : null,
        delivered_cases: f ? Number(f.delivered_cases || 0) : null,
        remaining_cases: f ? Number(f.remaining_cases != null ? f.remaining_cases : Math.max(0, Number(f.ordered_cases || 0) - Number(f.received_cases || 0))) : null,
        batch_cases: Number(b.cases || 0),
        remaining_days: sl.known ? sl.remainingDays : null,
        remaining_pct: sl.known ? sl.remainingPct : null,
        required_pct: sl.minPct,
        expired: !!sl.expired,
        decision,
      });
    });
  });

  const count = (code) => rows.filter((r) => r.decision.code === code).length;
  return {
    rows,
    summary: { batches: rows.length, accept: count('accept'), approval: count('approval'), reject: count('reject') },
  };
}
