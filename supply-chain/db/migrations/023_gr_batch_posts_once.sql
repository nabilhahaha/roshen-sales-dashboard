-- 023 — hard guarantee: each goods-receipt batch posts to inventory exactly
-- once. Together with the Pending QC → Releasing claim this makes a double
-- release (double click / parallel tabs) physically unable to double-count.
create unique index if not exists uq_movement_gr_batch_once
  on public.inventory_movements (gr_batch_id)
  where movement_type = 'GR' and gr_batch_id is not null;
