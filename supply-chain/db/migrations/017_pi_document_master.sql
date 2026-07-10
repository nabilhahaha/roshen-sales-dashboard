-- 017 — PI document master: the Purchase Invoice (supply_orders) stores the
-- supplier's document as-is. Modeled 1:1 on the real Roshen/Sweet Stories
-- proforma invoice (KS-397/2026): bilingual header block (company, VAT, CR,
-- address, bank/IBAN), customer block, document details, 14 line columns and
-- the totals block. Existing columns keep their meaning:
--   order_number  = the document number (auto SO-… only when absent)
--   ordered_cases = the document's "Box, Pcs" column (the tracked quantity)
--   price_case    = net price per case (taxable amount / boxes)
--   line_total    = generated ordered_cases * price_case (net case value)

alter table supply_orders
  add column if not exists document_type          text,          -- e.g. PROFORMA INVOICE
  add column if not exists supplier_vat           text,          -- VAT No.
  add column if not exists supplier_cr            text,          -- CR Number
  add column if not exists supplier_address       text,
  add column if not exists supplier_short_address text,          -- Short Address (e.g. RANA 4522)
  add column if not exists supplier_bank          text,
  add column if not exists supplier_iban          text,
  add column if not exists customer_name          text,          -- Customer
  add column if not exists customer_cr            text,          -- Customer CR
  add column if not exists customer_vat           text,          -- Customer VAT №
  add column if not exists currency               text,
  add column if not exists payment_terms          text,
  add column if not exists delivery_terms         text,
  add column if not exists salesman               text,          -- Salesman Name
  add column if not exists total_units            numeric,       -- TOTAL row: Number of Units
  add column if not exists total_net              numeric,       -- Total Net Amount
  add column if not exists total_vat              numeric,       -- Total VAT Amount
  add column if not exists total_gross            numeric,       -- Total Grand Amount
  add column if not exists gross_weight_kg        numeric,       -- Gross Total Weight, kg
  add column if not exists source_filename        text,
  add column if not exists header_extra           jsonb;         -- anything else on the document

alter table supply_order_items
  add column if not exists line_no            integer,           -- No.
  add column if not exists supplier_item_code text,              -- document "Item Code" verbatim (e.g. 0668)
  add column if not exists uom              text,                -- Unit of measure (bl, kg, pcs(80g)…)
  add column if not exists units_qty        numeric,             -- Number of Units
  add column if not exists unit_price       numeric,             -- Price, SAR (per unit)
  add column if not exists discount_percent numeric,             -- Discount, %
  add column if not exists net_unit_price   numeric,             -- Price after Discount, SAR
  add column if not exists taxable_amount   numeric,             -- Taxable Amount, SAR
  add column if not exists vat_percent      numeric,             -- VAT%
  add column if not exists vat_amount       numeric,             -- VAT Amt, SAR
  add column if not exists amount           numeric;             -- Amount, SAR (incl. VAT)

-- A PI line's price comes from the document; keep the line even when a price
-- can't be resolved (line_total is generated and simply stays null).
alter table supply_order_items alter column price_case drop not null;

comment on column supply_orders.order_number is
  'The PI document number (e.g. KS-397/2026). Auto SO-YYYY-#### only when the document has none.';
comment on column supply_order_items.units_qty is
  'Document "Number of Units". Delivery tracking uses ordered_cases (= document "Box, Pcs").';
