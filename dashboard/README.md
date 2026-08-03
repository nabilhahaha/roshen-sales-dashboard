# Roshen KSA — Sales Performance Dashboard

A **production-ready, 100% client-side** sales analytics dashboard. Upload the
daily Excel export and every KPI, chart, table and filter refreshes instantly —
no backend, no build step, no page reload. All processing happens in the
browser; **no data ever leaves your device**.

![stack](https://img.shields.io/badge/stack-HTML5%20·%20Bootstrap%205%20·%20Vanilla%20JS-blue)
![offline](https://img.shields.io/badge/runs-fully%20offline-success)

---

## Quick start

```
dashboard/
└── index.html   ← open this
```

1. **Open `dashboard/index.html`** in any modern browser (Chrome, Edge,
   Firefox, Safari). All libraries are bundled in `assets/vendor`, so it works
   **fully offline** — no internet connection needed.
2. **Drag & drop today's Excel file** onto the upload zone (or click
   *Browse files*).
3. Done. Every KPI card, chart, table and filter is populated from the file.

> **Tip — "Load sample data" button:** browsers block `fetch()` of local files
> when a page is opened via `file://`. The sample button therefore needs a tiny
> local server: `python3 -m http.server` inside `dashboard/`, then open
> `http://localhost:8000`. Drag-&-drop of *your own* file works either way —
> including plain `file://`.

### Daily workflow

The Excel structure never changes — only the data does. Each day:

1. Open the dashboard (it remembers your dark/light preference).
2. Drop the new file. Parsing a ~37,000-row / 5.7 MB export takes **~1 second**
   thanks to a custom fast .xlsx parser (see *Performance* below).
3. Slice with the global filters — everything updates live.

---

## Features

| Area | Details |
|---|---|
| **KPI cards** | Total Sales, Total/Active/Inactive Customers, Total Orders, Avg Order Value, Achievement %, Growth % (MoM), Collection, Outstanding |
| **Charts** (ApexCharts) | Sales Trend, Monthly Sales, Daily Sales, Sales by Region / City / Supervisor / Salesman / Channel / Category, Top 20 Customers, Pareto Analysis, Target vs Achievement, Customer Status, Product Mix (treemap) |
| **Tables** (DataTables) | Customer List, Inactive Customers, Top Customers, Product Sales, Salesman Performance, Route Performance — each searchable, sortable, paginated, exportable to **CSV / Excel / PDF / Copy / Print** |
| **Global filters** | Date range, Month, Region, City, Branch, Channel, Supervisor, Salesman, Route, Category, Brand — any change updates the whole dashboard instantly |
| **UX** | Drag-&-drop upload, loading overlay, graceful error handling, dark/light mode (persisted), responsive & mobile-friendly layout, print stylesheet, full-dashboard **PDF export**, smooth animations |

## Technology

- **HTML5 + Bootstrap 5** ([Tabler](https://github.com/tabler/tabler) design system as CSS base — MIT)
- **Vanilla JavaScript (ES6+)** — no frameworks
- **[SheetJS](https://sheetjs.com/) (xlsx.js)** — Excel parsing (compatibility path)
- **[ApexCharts](https://apexcharts.com/)** — all 14 charts
- **[DataTables 2](https://datatables.net/)** + Buttons (JSZip / pdfmake) — tables & exports
- **Font Awesome 6** — icons
- **html2canvas + jsPDF** — "Export dashboard to PDF"

All third-party assets are vendored under `assets/vendor/` (≈6 MB), so the
dashboard has **zero runtime dependencies on the internet**.

---

## Base template — research & choice

Ten popular open-source Bootstrap dashboard templates were compared before
building (stars are approximate at the time of writing):

| # | Template | License | Bootstrap | Stars | Notes |
|---|----------|---------|-----------|-------|-------|
| 1 | **Tabler** ⭐ chosen | MIT | 5 | ~39k | Modern flat UI, first-class dark mode, pure CSS/JS, superb docs, very active |
| 2 | AdminLTE 3/4 | MIT | 4→5 | ~44k | Hugely popular but visually dated; v4 (BS5) long in beta |
| 3 | CoreUI Free | MIT | 5 | ~11k | Solid, but free tier is a funnel to Pro; more framework-oriented |
| 4 | Volt Dashboard | MIT (free tier) | 5 | ~4k | Nice design; limited free components; Themesberg upsell |
| 5 | Star Admin 2 | MIT | 5 | ~2.5k | Decent, less active maintenance |
| 6 | Sneat (free) | MIT | 5 | ~1k | Attractive, but free version is a trimmed teaser of the paid one |
| 7 | DashLite | Paid (ThemeForest) | 5 | n/a | **Not legally reusable** — commercial license, excluded |
| 8 | Mosaic Lite | GPL/paid hybrid | Tailwind | ~2k | Tailwind, not Bootstrap; license friction |
| 9 | SB Admin 2 | MIT | 4 | ~10k | Bootstrap 4, effectively unmaintained |
| 10 | Gentelella | MIT | 3/4 | ~22k | Legacy Bootstrap, jQuery-heavy, stale |

**Why Tabler won:** MIT license with no paid upsell traps, genuinely modern UI,
built *on* Bootstrap 5 (so all BS5 utilities work), CSS-variable theming that
made the Roshen brand + dark mode trivial, excellent documentation, and active
maintenance. Its stylesheet is used as the base layer; the dashboard shell
(sidebar, topbar, KPI cards, panels) is custom-built on top in
`css/styles.css`.

---

## Project structure

```
dashboard/
├── index.html                 # single page — open this
├── css/
│   └── styles.css             # custom enterprise theme (light + dark tokens)
├── js/
│   ├── config.js              # ★ Excel column mapping + business rules
│   ├── utils.js               # formatting, dates, DOM, CSV helpers
│   ├── fastParser.js          # high-performance .xlsx reader (fast path)
│   ├── dataStore.js           # parse → normalise → filter (single source of data)
│   ├── aggregations.js        # one-pass metric engine (KPIs / series / lists)
│   ├── kpis.js                # KPI card components
│   ├── charts.js              # 14 ApexCharts (create-once, update-in-place)
│   ├── tables.js              # 6 DataTables + export buttons
│   ├── filters.js             # data-driven global filter bar
│   ├── upload.js              # drag-&-drop, loader, error handling
│   ├── theme.js               # dark/light, print, dashboard-to-PDF
│   └── app.js                 # orchestration & refresh cycle
├── assets/
│   └── vendor/                # all third-party libs (offline)
├── sample-data/
│   └── Sample_Sales_Data.xlsx # synthetic file with the exact real structure
└── README.md
```

### Architecture (data flow)

```
Excel file ──▶ upload.js ──▶ dataStore.loadArrayBuffer()
                                │  fastParser.js (fast path)  ⇢ SheetJS (fallback)
                                ▼
                     normalised row records (once per upload)
                                │
   filter change ──▶ dataStore.getFilteredRows()   O(n) single pass
                                ▼
                     aggregations.compute(rows)     O(n) single pass
                                ▼
        ┌───────────────┬──────────────────┬────────────────┐
        ▼               ▼                  ▼                ▼
     kpis.update    charts.renderAll   tables.update   header badges
```

---

## Configuration — `js/config.js`

Everything file-specific lives in **one file**. If a column header changes in
the Excel export, edit only the mapping:

```js
columns: {
  netAmount:   'Net Amount Excl Vat',   // ← exact Excel header (case/space-insensitive)
  productName: 'Product Name',
  city:        ['City Name En', 'City'], // arrays = accepted aliases
  ...
}
```

Other knobs in the same file:

| Setting | Purpose | Default |
|---|---|---|
| `salesMeasure` | which column all KPIs/charts sum | `netAmount` (returns already negative) |
| `kpis.activeWindowDays` | customer counts as *Active* if they bought within N days of the latest date in view | `90` |
| `kpis.monthlyTargetSar` | monthly sales target for Achievement % / Target-vs-Achievement | `1,600,000` |
| `kpis.collectionRatePct` | the file has no accounts-receivable data, so Collection/Outstanding are estimated from invoiced (VAT-incl.) value | `0.85` |
| `normalize.replacements` | dimension-value cleanup (e.g. `"Damam" → "Dammam"`) | see file |
| `normalize.regionFromBranch` | maps raw branch names to clean Regions | see file |
| `filters` | order/labels of the global filter bar | 11 filters |
| `charts.*` | top-N sizes, Pareto source | see file |

> **Route & Brand:** this dataset has no dedicated Route or Brand columns, so
> those filters proxy to **Branch (territory)** and **Sub-Category** — clearly
> marked in `config.js`. Repoint them the moment real columns exist.

---

## Performance

Designed for **100,000+ rows**:

- **Custom fast .xlsx parser** (`fastParser.js`): the daily ERP export inflates
  to ~44 MB of worksheet XML, which takes SheetJS 15–20 s to read. The fast
  path (JSZip + tight regex scan) reads the same file in **~1 s** and falls
  back to SheetJS automatically on anything unusual. Measured end-to-end
  (upload → all 14 charts rendered): **~3.4 s for 37k rows**, ≈0.6 s of which
  is chart rendering.
- **Normalise once, filter fast**: rows are typed/cleaned a single time at
  upload; every filter change is one O(n) equality pass + one O(n)
  aggregation pass (≈100 ms per 37k rows).
- **Update-in-place UI**: charts use `updateOptions` (no destroy/re-create);
  DataTables use `clear().rows.add().draw()` with `deferRender`.

## Business rules worth knowing

- **Returns** (`Good/Damaged/Expire returns`, `Credit Note`) arrive as negative
  amounts in the file and are **netted into every figure automatically**.
- **Total Orders** counts distinct `Doc Id`s.
- **Growth %** compares the latest month in view vs the previous month.
- **Achievement %** = net sales ÷ (monthly target × months in view).
- Blank dimension values display as `(Unspecified)` rather than vanishing.

## Browser support

Evergreen browsers (Chrome/Edge/Firefox/Safari, last ~2 years). No IE11.

## Adding a new chart (example)

1. Add a container in `index.html`: `<div id="chart-myChart" class="chart"></div>`
2. Add a builder in `charts.js` and list its id in the `ORDER` array.
3. If it needs a new grouping, add one line to the loop in
   `aggregations.compute()`.

That's it — filters, theming and refresh wiring come for free.
