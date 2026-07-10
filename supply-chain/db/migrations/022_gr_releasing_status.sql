-- 022 — 'Releasing' claim status for goods receipts: releaseGoodsReceipt
-- atomically claims Pending QC → Releasing so two parallel releases (double
-- click / second tab) can never both post inventory.
alter table public.goods_receipts drop constraint if exists goods_receipts_status_check;
alter table public.goods_receipts add constraint goods_receipts_status_check
  check (status = any (array['Pending QC','Releasing','Partially Released','Released','Rejected','Cancelled']));
