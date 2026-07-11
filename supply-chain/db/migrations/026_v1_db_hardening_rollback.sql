-- ROLLBACK for 026_v1_db_hardening — restores the exact pre-026 state.
-- Tested against production inside a transaction (BEGIN → rollback script →
-- state assertions → ROLLBACK), so the script is proven executable without
-- production ever leaving the hardened state.
--
-- Note: 026 is a pure hardening migration (no schema/data shape changes),
-- so this rollback is loss-free in both directions.

-- 5 ▸ views back to the pre-026 default (security definer)
alter view batch_stock set (security_invoker = false);
alter view po_line_fulfillment set (security_invoker = false);
alter view inventory set (security_invoker = false);
alter view inventory_balances set (security_invoker = false);
alter view inventory_sku_balances set (security_invoker = false);

-- 4 ▸ un-pin search_path
alter function recompute_order_fulfillment(bigint) reset search_path;
alter function trg_gr_confirmed() reset search_path;
alter function trg_recompute_dn_batch() reset search_path;
alter function trg_recompute_gr_batch() reset search_path;
alter function sku_version_bump() reset search_path;
alter function link_sku_id() reset search_path;
alter function inv_txn_enrich() reset search_path;
alter function po_amendment_immutable() reset search_path;

-- 3 ▸ drop the FK covering indexes
drop index if exists batch_master_dn_batch_idx;
drop index if exists batch_master_gr_idx;
drop index if exists dn_audit_log_order_idx;
drop index if exists document_attachments_supersedes_idx;
drop index if exists gr_batches_dn_batch_idx;
drop index if exists gr_batches_dn_item_idx;
drop index if exists gr_batches_po_item_idx;
drop index if exists gr_batches_si_item_idx;
drop index if exists inv_movements_dn_batch_idx;
drop index if exists inv_movements_dn_idx;
drop index if exists inv_movements_gr_idx;
drop index if exists po_amendment_lines_item_idx;
drop index if exists po_pi_disputes_pi_idx;
drop index if exists shelf_life_exceptions_dn_idx;
drop index if exists shelf_life_exceptions_dn_item_idx;
drop index if exists si_disputes_dn_idx;
drop index if exists si_documents_order_idx;
drop index if exists supplier_invoices_parent_idx;
drop index if exists supplier_invoices_superseded_idx;
drop index if exists supply_order_items_item_code_idx;
drop index if exists supply_order_revisions_pi_idx;

-- 2 ▸ recreate the duplicate unique index exactly as it existed
create unique index if not exists uq_sku_item_code on sku_master(item_code);

-- 1 ▸ RLS off again on the amendment tables (immutability triggers unaffected)
drop policy if exists po_amendments_all on po_amendments;
drop policy if exists po_amendment_lines_all on po_amendment_lines;
drop policy if exists po_amendment_audit_all on po_amendment_audit;
alter table po_amendments disable row level security;
alter table po_amendment_lines disable row level security;
alter table po_amendment_audit disable row level security;
