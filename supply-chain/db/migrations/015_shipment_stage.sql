-- =====================================================================
-- Migration 015 — shipment stage on the Delivery Note (minimal)
--
-- Business rule: after the supplier invoice is matched, the shipment is
-- "Ready for Delivery" / "In Transit" with an Expected Delivery Date & Time —
-- it is NOT yet inventory. Goods Receipt happens only when the arrival is
-- confirmed. The DN is the shipment document, so this adds exactly two
-- things: the expected-delivery timestamp and the two shipment statuses.
-- Applied as "shipment_stage".
-- =====================================================================
alter table public.delivery_notes
  add column if not exists expected_delivery_at timestamptz;

alter table public.delivery_notes drop constraint if exists delivery_notes_status_check;
alter table public.delivery_notes
  add constraint delivery_notes_status_check
  check (status = any (array[
    'Draft','Imported','Ready for Delivery','In Transit',
    'Receiving Review','Received','Cancelled','Reversed']));
