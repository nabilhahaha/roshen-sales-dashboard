# Roshen Supply Chain

An independent, ERP-style Supply Chain application. It shares **only the
Supabase database** with the Sales Dashboard — no UI, layout, or business code
is shared. Buildless ES modules (no bundler); deployed as a static site.

## Architecture

Strict layering — **Pages → Services → Supabase**. Pages never touch Supabase
directly; business logic (PI parsing, comparison, workflow) lives in pure
service modules.

```
src/
  app.js                     # bootstrap + router
  components/                # presentational only
    layout/ sidebar/ topbar/ modal/ table/ forms/ notifications/
  pages/                     # one folder per module (render into a fresh node)
    dashboard/ sku-master/ purchase-orders/ order-history/
    pi-import/ validation/ workflow/
  services/                  # the only place that talks to Supabase
    supabase/                #   shared client
    sku/ purchase-orders/ pi/ workflow/
  models/                    # status enums + navigation map (single source)
  utils/                     # format, dom, documents (print/excel)
  styles/app.css
```

## Modules

Active: Dashboard, SKU Master, Purchase Orders, Order History, PI Import,
PI Validation, Workflow. Reserved (placeholders): Shipment, Goods Receiving,
Inventory, Batch Tracking, Expiry, Returns to Supplier, Claims, Reports,
Settings.

## Workflow

`PO Draft → Approved → PI Imported → PI Approved → Closed` ·
PI: `Imported → Validation Required → Approved / Rejected`. PI lines are parsed
from the original Roshen Excel (table detected dynamically) and compared to the
approved order by Item Code → Roshen ID.

## Auth

Development build: no login. A real auth/authorization system will be added
later and is intentionally not designed around this build.

## Run locally

Any static server, e.g. `python3 -m http.server` from this folder, then open
`index.html`. Supabase + SheetJS load from CDN.
