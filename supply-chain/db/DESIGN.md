# Supply Chain — Delivery, Receiving, Batch & Inventory Design

This is the data foundation for the Delivery Note module. It was designed
**before** any DN code, so partial deliveries, batch traceability and
shelf-life are modelled from the database level up.

## Relationship model

```
Purchase Order ───< Delivery Note (N)          one PO → many DNs (partial delivery)
Purchase Order ───< Supplier Invoice (N)       one PO → many invoices
Purchase Order ───< Goods Receipt (N)          one PO → many receipts

Delivery Note ─── 1:1 ─── Supplier Invoice     each DN needs exactly one matched
                                               invoice before its GR can be released

Delivery Note ───< DN Line (one per SKU) ───< DN Batch (1..N physical batches)
Goods Receipt ───< GR Batch (batch-level QC)
GR Batch (Released) ──> Inventory Movement ──> Inventory (per-batch balance)
```

### Line-level traceability chain (FEFO-ready)

```
PO line → DN line → DN batch → GR batch → inventory movement → inventory batch
```

Every child row carries an explicit FK to its parent (`po_item_id`,
`dn_item_id`, `dn_batch_id`, `si_item_id`, `gr_batch_id`). The chain is never
broken, so future inventory always knows which PO / revision / DN / batch a
case came from.

## Core principles

1. **No auto-close.** Operational completion (delivery / receipt) and
   financial completion (invoice match / financial closure) are tracked
   **separately**. The PO is never automatically closed when remaining hits
   zero. Statuses:
   `Approved → Partially Delivered → Fully Delivered → Partially Received →
   Fully Received → Invoice Matched → Financially Closed`.
   The DB trigger only advances the *operational* status; the two financial
   states are explicit user actions.

2. **Three independent balances** per PO line, from the
   `po_line_fulfillment` view — never stored:
   - `open_delivery = ordered − delivered`
   - `open_invoice  = delivered − invoiced`
   - `open_receipt  = delivered − received`
   Keeping them separate makes operational issues visible (e.g. delivered
   but not invoiced, delivered but not received).

3. **Matching is only by Item Code or Roshen ID** — never by description.
   The ledger line key is `coalesce(roshen_id, item_code)`.

4. **Batch-based everything.** A DN line (one SKU) can hold many physical
   batches with different expiry dates. Shelf life, QC and inventory are
   always computed/stored per **batch**, never per DN line.

5. **Goods Receipt QC** per batch: `Pending QC → Released / Rejected`.
   Inventory increases **only** for `Released` batches.

6. **Movement-based inventory.** `inventory_movements` is the source of
   truth (with source-document refs + `unit_cost` for future costing).
   The `inventory` table is a derived running balance per
   `(roshen_id, batch_no, expiry_date, warehouse)`.

## Shelf-life management

- **SKU Master** holds the master data (maintained manually):
  `shelf_life_value`, `shelf_life_unit` (Days/Months/Years),
  `min_remaining_shelf_life_pct` (per-SKU receiving minimum).
- **Delivery Note batch** holds the facts: `manufacturing_date`,
  `expiry_date`.
- All shelf-life figures — Total, Remaining, Remaining %, Consumed %,
  Remaining Days — are **computed dynamically from dates**, never stored.
  If manufacturing date is absent, calculations use expiry only
  (`manufacturing = expiry − shelf_life`).
- **Receiving colour coding** (remaining %): Green ≥70, Yellow 50–69,
  Orange 30–49, Red <30.
- **Minimum receiving rule**: when a batch's remaining % is below the SKU
  minimum it is flagged *"Below Receiving Shelf Life Requirement"* — never
  auto-rejected. The warehouse manager may **Accept Exception** or **Reject
  Item**; every decision is written to `shelf_life_exceptions` (audit).

## Supplier invoice (received document)

The supplier invoice is **received** as the supplier's own document (PDF now,
ZATCA XML later) — it is **not created** in the ERP. From a delivery note the
user **uploads the PDF**; the system:

1. stores the original file for audit (`supplier_invoice_documents`, base64 —
   kept out of `storage.objects`, which carries Sales-Dashboard policies anon
   cannot evaluate),
2. extracts the header (invoice #, date, seller, buyer, PO/DN reference),
   totals (net / VAT / grand) and line items via `pdf.js`,
3. lets the user verify/correct the extracted data and **bind each invoice line
   to the delivery-note SKU** (the system never silently matches by
   description — supplier invoices carry no item code),
4. validates against the delivery note at the **value** level (invoice net vs
   DN expected net = delivered cartons × PO case price) plus DN/PO reference
   identity — differences open an **Invoice Validation** screen,
5. sets the invoice **Matched** (unlocks Goods Receiving) or **Disputed**.

## Tables

| Table | Purpose |
|---|---|
| `delivery_notes` | DN header (many per PO) |
| `delivery_note_items` | DN line, one per SKU |
| `delivery_note_batches` | physical batches (1..N per line) |
| `supplier_invoices` | invoice header (1:1 with a DN); uploaded PDF, extracted data + validation |
| `supplier_invoice_items` | invoice line (bound to a DN SKU) |
| `supplier_invoice_documents` | original uploaded file (base64) for audit |
| `goods_receipts` | GR header (one per DN) |
| `goods_receipt_batches` | batch-level receiving + QC |
| `shelf_life_exceptions` | audit of below-minimum accept/reject decisions |
| `inventory_movements` | source of truth for stock |
| `inventory` | derived per-batch running balance |
| `po_line_fulfillment` | **view** — per-line ordered/delivered/invoiced/received + three open balances |

## Status vocabularies

- **Delivery Note**: Imported → Receiving Review → Received (Cancelled)
- **Supplier Invoice**: Imported → Matched (Disputed / Cancelled)
- **Goods Receipt**: Pending QC → Partially Released / Released / Rejected (Cancelled)
- **DN / GR Batch QC**: Pending QC → Released / Rejected
- **Purchase Order** (added): Partially Delivered, Fully Delivered,
  Partially Received, Fully Received, Invoice Matched, Financially Closed
