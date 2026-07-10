-- 018 — real-document fidelity for the Delivery Note and Supplier Invoice.
-- Modeled on the real documents:
--   DN-783/2026 "Goods Issue Note" (Excel) — full bilingual supplier/customer
--   header block, PO reference, lot-level lines (same SKU repeated with
--   different expiry dates), Carton/Box/Pcs quantities, warehouse
--   confirmation block.
--   INV-2026-000383 ZATCA "Tax Invoice" (PDF) — due date, payment terms
--   (Net 45), seller TRN/CRN, buyer TRN, notes.
-- Nothing is lost during import; original values are never overwritten.

alter table delivery_notes
  add column if not exists document_type          text,   -- e.g. Goods Issue Note
  add column if not exists customer               text,
  add column if not exists customer_vat           text,
  add column if not exists customer_cr            text,
  add column if not exists supplier_vat           text,
  add column if not exists supplier_cr            text,
  add column if not exists supplier_address       text,
  add column if not exists supplier_short_address text,
  add column if not exists supplier_bank          text,
  add column if not exists supplier_iban          text,
  add column if not exists received_by            text;   -- warehouse confirmation

alter table supplier_invoices
  add column if not exists due_date      date,
  add column if not exists payment_terms text,            -- e.g. Net 45
  add column if not exists seller_vat    text,            -- seller TRN
  add column if not exists seller_cr    text,             -- seller CRN
  add column if not exists buyer_vat     text,            -- buyer TRN
  add column if not exists doc_notes     text;            -- document Notes block
