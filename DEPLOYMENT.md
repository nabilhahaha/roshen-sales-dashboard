# Deployment — Roshen KSA Sales Dashboard (with Supply Chain module)

This is a **static single-page app** (`index.html` at the repo root). No build
step, no server, no Node runtime. It is deployed by serving `index.html` at `/`.

`vercel.json` pins this: `framework: null`, no build/install command, output = repo
root. Vercel serves `index.html` directly.

## Deploy via GitHub → Vercel (recommended: auto-deploys on every push to `main`)

1. Go to <https://vercel.com/new> and sign in as the account that owns this repo.
2. **Import Git Repository** → select **`nabilhahaha/roshen-sales-dashboard`**
   (grant the Vercel GitHub app access to this repo if prompted).
3. Configure Project:
   - **Framework Preset:** `Other` (auto-detected; `vercel.json` already sets this).
   - **Build Command:** _empty_ / disabled.
   - **Output Directory:** `.` (repo root).
   - **Install Command:** _empty_ / disabled.
   - **Root Directory:** `./`
4. **Environment Variables:** _none required_ (see below).
5. **Deploy.** The first build publishes `main` to a production URL, e.g.
   `https://roshen-sales-dashboard.vercel.app`.
6. Every later push to `main` auto-deploys to production; every PR gets a
   preview URL automatically.

## Environment variables

**None are required.** The app is a static file; the Supabase **project URL** and
**publishable (anon) key** are embedded in the page (the publishable key is
public by design — access is governed by Row-Level Security in Supabase). There
is no build step in which server-side env vars could be injected, so the config
stays in-page.

## Supabase backend

- Project: **Roshen** (`wrkugzssuoxneftzappa`), region `ap-northeast-1`.
- Tables (RLS enabled): `sku_master`, `supply_orders`, `supply_order_items`,
  `proforma_invoices`, `proforma_invoice_items`.
- SKU Master seeded with the 72 July-2026 SKUs.
- All migrations are already applied to the live project — no migration step is
  needed at deploy time. The deployed page connects to Supabase directly from
  the browser.

## Notes

- Because this is a static site, `vercel.json` intentionally disables the build
  and install commands so Vercel does not attempt to run a framework build.
- No secrets are stored in the repo. The only Supabase key present is the
  publishable/anon key, which is safe to expose in client code.
