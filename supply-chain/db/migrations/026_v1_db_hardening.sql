-- 026 — V1.0 stabilization: database hardening (no behavior change)
--
-- Findings from the Supabase security/performance advisors, scoped strictly
-- to supply-chain objects (this Postgres project is shared with the sales
-- dashboard — its tables are not touched here):
--   1. po_amendments / po_amendment_lines / po_amendment_audit had RLS
--      disabled entirely. Enable it with the same permissive policy the rest
--      of the app uses today (the app runs NO-AUTH; real role-based policies
--      arrive with the auth release).
--   2. sku_master carried two identical unique indexes on item_code —
--      uq_sku_item_code duplicated the sku_master_item_code_key constraint.
--   3. 21 supply-chain foreign keys had no covering index.
--   4. Supply-chain trigger/helper functions had a mutable search_path.
--   5. Supply-chain views defaulted to SECURITY DEFINER; switch to invoker
--      (identical results under the current allow-all policies, but they
--      will respect real RLS when it lands).

-- 1 ▸ RLS on the amendment tables (immutability triggers stay the real guard)
alter table po_amendments enable row level security;
alter table po_amendment_lines enable row level security;
alter table po_amendment_audit enable row level security;
drop policy if exists po_amendments_all on po_amendments;
create policy po_amendments_all on po_amendments for all using (true) with check (true);
drop policy if exists po_amendment_lines_all on po_amendment_lines;
create policy po_amendment_lines_all on po_amendment_lines for all using (true) with check (true);
drop policy if exists po_amendment_audit_all on po_amendment_audit;
create policy po_amendment_audit_all on po_amendment_audit for all using (true) with check (true);

-- 2 ▸ duplicate unique index (the FK depends on sku_master_item_code_key)
drop index if exists uq_sku_item_code;

-- 3 ▸ covering indexes for unindexed foreign keys
create index if not exists batch_master_dn_batch_idx on batch_master(dn_batch_id);
create index if not exists batch_master_gr_idx on batch_master(gr_id);
create index if not exists dn_audit_log_order_idx on dn_audit_log(order_id);
create index if not exists document_attachments_supersedes_idx on document_attachments(supersedes_id);
create index if not exists gr_batches_dn_batch_idx on goods_receipt_batches(dn_batch_id);
create index if not exists gr_batches_dn_item_idx on goods_receipt_batches(dn_item_id);
create index if not exists gr_batches_po_item_idx on goods_receipt_batches(po_item_id);
create index if not exists gr_batches_si_item_idx on goods_receipt_batches(si_item_id);
create index if not exists inv_movements_dn_batch_idx on inventory_movements(dn_batch_id);
create index if not exists inv_movements_dn_idx on inventory_movements(dn_id);
create index if not exists inv_movements_gr_idx on inventory_movements(gr_id);
create index if not exists po_amendment_lines_item_idx on po_amendment_lines(po_item_id);
create index if not exists po_pi_disputes_pi_idx on po_pi_disputes(pi_id);
create index if not exists shelf_life_exceptions_dn_idx on shelf_life_exceptions(dn_id);
create index if not exists shelf_life_exceptions_dn_item_idx on shelf_life_exceptions(dn_item_id);
create index if not exists si_disputes_dn_idx on supplier_invoice_disputes(delivery_note_id);
create index if not exists si_documents_order_idx on supplier_invoice_documents(order_id);
create index if not exists supplier_invoices_parent_idx on supplier_invoices(parent_invoice_id);
create index if not exists supplier_invoices_superseded_idx on supplier_invoices(superseded_by);
create index if not exists supply_order_items_item_code_idx on supply_order_items(item_code);
create index if not exists supply_order_revisions_pi_idx on supply_order_revisions(pi_id);

-- 4 ▸ pin search_path on supply-chain functions
alter function recompute_order_fulfillment(bigint) set search_path = public;
alter function trg_gr_confirmed() set search_path = public;
alter function trg_recompute_dn_batch() set search_path = public;
alter function trg_recompute_gr_batch() set search_path = public;
alter function sku_version_bump() set search_path = public;
alter function link_sku_id() set search_path = public;
alter function inv_txn_enrich() set search_path = public;
alter function po_amendment_immutable() set search_path = public;

-- 5 ▸ views run with the caller's permissions
alter view batch_stock set (security_invoker = true);
alter view po_line_fulfillment set (security_invoker = true);
alter view inventory set (security_invoker = true);
alter view inventory_balances set (security_invoker = true);
alter view inventory_sku_balances set (security_invoker = true);
