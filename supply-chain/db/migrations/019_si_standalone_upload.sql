-- 019 — standalone Supplier Invoice upload.
-- A supplier invoice can now be uploaded directly (Supplier Invoices page),
-- before its PI / Delivery Note exist in the system. Linking is automatic via
-- the document references (PO ref / DN ref); an invoice whose documents are
-- not found yet stays in 'Pending Matching' with no PI link.

alter table supplier_invoices alter column order_id drop not null;

alter table supplier_invoices drop constraint if exists supplier_invoices_status_check;
alter table supplier_invoices add constraint supplier_invoices_status_check
  check (status = any (array['Pending Matching'::text, 'Imported'::text, 'Matched'::text,
                             'Partially Matched'::text, 'Disputed'::text, 'Replaced'::text, 'Cancelled'::text]));

-- Unlinked active invoices are unique by invoice number (the per-PI unique
-- index does not cover NULL order_id).
create unique index if not exists uq_si_pending_number
  on supplier_invoices (invoice_number)
  where order_id is null and status not in ('Replaced', 'Cancelled');
