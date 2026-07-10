-- One ACTIVE goods receipt per delivery note. A cancelled (reversed) receipt
-- must not block re-receiving the delivery after its data was corrected —
-- reverse → fix → receive again is the standard repair workflow.
alter table goods_receipts drop constraint goods_receipts_dn_unique;
create unique index goods_receipts_dn_unique
  on goods_receipts (delivery_note_id)
  where status <> 'Cancelled';
