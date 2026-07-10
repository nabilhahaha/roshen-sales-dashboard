-- =====================================================================
-- Migration 009 — fulfillment ledger: invoiced balance across doc types
--
-- The invoiced side of po_line_fulfillment now:
--   * excludes Replaced invoices (a superseded document must not count),
--     as well as Cancelled (already excluded);
--   * naturally nets Credit Notes / Debit Notes, which are stored as
--     supplier_invoices rows whose lines carry signed invoiced_cases
--     (a credit note reduces the invoiced quantity/value of a PO line).
--
-- Everything else (effective PO lines, delivered, received, the three open
-- balances) is unchanged from migration 007. Applied to Supabase as
-- "fulfillment_invoiced_doctypes".
-- =====================================================================
create or replace view public.po_line_fulfillment as
 WITH effective AS (
         SELECT o.id AS order_id,
            COALESCE(NULLIF(x.roshen_id, ''::text), x.item_code) AS line_key,
            x.item_code, x.roshen_id, x.item_description AS description,
            x.ordered_cases, x.price_case
           FROM supply_orders o
             CROSS JOIN LATERAL ( SELECT ( SELECT r_1.id
                           FROM supply_order_revisions r_1
                          WHERE r_1.order_id = o.id
                          ORDER BY r_1.revision_no DESC
                         LIMIT 1) AS rev_id) lr
             JOIN LATERAL ( SELECT ri.item_code, ri.roshen_id, ri.item_description, ri.ordered_cases, ri.price_case
                   FROM supply_order_revision_items ri
                  WHERE ri.revision_id = lr.rev_id
                UNION ALL
                 SELECT oi.item_code, oi.roshen_id, oi.item_description, oi.ordered_cases, oi.price_case
                   FROM supply_order_items oi
                  WHERE oi.order_id = o.id AND lr.rev_id IS NULL) x ON true
        ), eff AS (
         SELECT effective.order_id, effective.line_key,
            max(effective.item_code) AS item_code,
            max(effective.roshen_id) AS roshen_id,
            max(effective.description) AS description,
            max(effective.price_case) AS price_case,
            sum(effective.ordered_cases) AS ordered_cases
           FROM effective
          WHERE effective.line_key IS NOT NULL
          GROUP BY effective.order_id, effective.line_key
        ), delivered AS (
         SELECT dn.order_id,
            COALESCE(NULLIF(di.roshen_id, ''::text), di.item_code) AS line_key,
            sum(b.cases) AS delivered_cases
           FROM delivery_notes dn
             JOIN delivery_note_items di ON di.dn_id = dn.id
             JOIN delivery_note_batches b ON b.dn_item_id = di.id
          WHERE dn.status <> ALL (ARRAY['Cancelled'::text, 'Reversed'::text])
          GROUP BY dn.order_id, (COALESCE(NULLIF(di.roshen_id, ''::text), di.item_code))
        ), invoiced AS (
         SELECT si.order_id,
            COALESCE(NULLIF(sii.roshen_id, ''::text), sii.item_code) AS line_key,
            sum(sii.invoiced_cases) AS invoiced_cases
           FROM supplier_invoices si
             JOIN supplier_invoice_items sii ON sii.invoice_id = si.id
          WHERE si.status <> ALL (ARRAY['Cancelled'::text, 'Replaced'::text])
          GROUP BY si.order_id, (COALESCE(NULLIF(sii.roshen_id, ''::text), sii.item_code))
        ), received AS (
         SELECT gr.order_id,
            COALESCE(NULLIF(gb.roshen_id, ''::text), gb.item_code) AS line_key,
            sum(gb.received_cases) AS received_cases
           FROM goods_receipts gr
             JOIN goods_receipt_batches gb ON gb.gr_id = gr.id
          WHERE gb.qc_result = 'Released'::text AND (gr.status = ANY (ARRAY['Released'::text, 'Partially Released'::text]))
          GROUP BY gr.order_id, (COALESCE(NULLIF(gb.roshen_id, ''::text), gb.item_code))
        )
 SELECT e.order_id, e.line_key, e.item_code, e.roshen_id, e.description, e.price_case, e.ordered_cases,
    COALESCE(d.delivered_cases, 0::numeric) AS delivered_cases,
    COALESCE(i.invoiced_cases, 0::numeric) AS invoiced_cases,
    COALESCE(r.received_cases, 0::numeric) AS received_cases,
    e.ordered_cases - COALESCE(d.delivered_cases, 0::numeric) AS open_delivery,
    COALESCE(d.delivered_cases, 0::numeric) - COALESCE(i.invoiced_cases, 0::numeric) AS open_invoice,
    COALESCE(d.delivered_cases, 0::numeric) - COALESCE(r.received_cases, 0::numeric) AS open_receipt
   FROM eff e
     LEFT JOIN delivered d ON d.order_id = e.order_id AND d.line_key = e.line_key
     LEFT JOIN invoiced i ON i.order_id = e.order_id AND i.line_key = e.line_key
     LEFT JOIN received r ON r.order_id = e.order_id AND r.line_key = e.line_key;
