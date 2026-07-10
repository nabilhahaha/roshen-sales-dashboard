-- 020 — Version 1.0 future-proofing. NON-BREAKING only: reporting/analytics
-- indexes and one relaxed check constraint. No table shapes, no workflow, no
-- behavior change. Prepares for the next phase (reports, dashboards,
-- inventory, returns, claims, approvals, analytics) without schema breaks.

-- Attachments are the generic document-file spine; future modules (returns,
-- claims, approvals) attach files too. Naming convention enforced app-side.
alter table document_attachments drop constraint if exists document_attachments_doc_type_check;
alter table document_attachments add constraint document_attachments_doc_type_check
  check (doc_type ~ '^[a-z][a-z0-9_]{2,40}$');

-- Integrity fix found by the V1 stability review: shelf_life_exceptions has
-- four ON DELETE SET NULL FKs. During one cascading delete, the SET NULL
-- update fired by one FK re-validates the row's OTHER FK columns mid-cascade
-- — before their own SET NULL actions ran — and aborts the delete. Deferring
-- the checks to commit time validates the final (consistent) state instead.
-- Same audit semantics: exception rows are kept forever, references null out.
alter table shelf_life_exceptions
  alter constraint shelf_life_exceptions_order_id_fkey deferrable initially deferred,
  alter constraint shelf_life_exceptions_dn_id_fkey deferrable initially deferred,
  alter constraint shelf_life_exceptions_dn_item_id_fkey deferrable initially deferred,
  alter constraint shelf_life_exceptions_dn_batch_id_fkey deferrable initially deferred;

-- Status / dimension filters used by dashboards and reports.
create index if not exists idx_supply_orders_status     on supply_orders (status);
create index if not exists idx_supply_orders_supplier   on supply_orders (supplier);
create index if not exists idx_si_status                on supplier_invoices (status);
create index if not exists idx_gr_status                on goods_receipts (status);
create index if not exists idx_dn_expected_delivery     on delivery_notes (expected_delivery_at);

-- Line-level reconciliation joins (PO item ↔ DN item ↔ SI item).
create index if not exists idx_dn_items_po_item         on delivery_note_items (po_item_id);
create index if not exists idx_si_items_dn_item         on supplier_invoice_items (dn_item_id);
create index if not exists idx_si_items_po_item         on supplier_invoice_items (po_item_id);

-- Inventory analytics slicing (the movement ledger is the fact table).
create index if not exists idx_inv_moves_warehouse      on inventory_movements (warehouse);
create index if not exists idx_inv_moves_type           on inventory_movements (movement_type);
create index if not exists idx_inv_moves_created        on inventory_movements (created_at);
create index if not exists idx_batch_master_order       on batch_master (order_id);

-- Exception / audit timelines (compliance reports).
create index if not exists idx_shelf_exc_dn_batch       on shelf_life_exceptions (dn_batch_id);
create index if not exists idx_shelf_exc_decided        on shelf_life_exceptions (decided_at);
create index if not exists idx_dn_audit_created         on dn_audit_log (created_at);
create index if not exists idx_si_audit_created         on supplier_invoice_audit_log (created_at);
create index if not exists idx_si_audit_order           on supplier_invoice_audit_log (order_id);
create index if not exists idx_sku_audit_created        on sku_audit_log (created_at);
create index if not exists idx_batch_audit_created      on batch_audit_log (created_at);
