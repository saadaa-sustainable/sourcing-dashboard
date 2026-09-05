# SAADAA Sourcing Dashboard

Production-oriented migration of the Sourcing Dashboard to Next.js 16, Supabase, and Vercel. It covers open PO tracking, vendor and merchant performance, TNA stage mapping, product rollups, and product/vendor matrices.

**Docs:** [`USER-GUIDE.md`](USER-GUIDE.md) — plain-language guide for the team (every screen, metric and FAQ) · [`DOCUMENTATION.md`](DOCUMENTATION.md) — technical / data-pipeline reference.

## Local setup

Requires Node 22.13+.

```bash
npm install
cp .env.example .env.local   # Windows: copy .env.example .env.local
npm run dev
```

Fill `.env.local` with your Supabase project's URL and publishable key (see [Supabase setup](#supabase-setup)); with both set, authentication and live RLS-protected reads are mandatory.

**Fixture mode:** leaving both variables blank makes the loader (`src/lib/data.ts`) read CSV exports from `data/fixtures/`. Those exports contain **real sourcing data and are gitignored — they are not in the repo**, so a fresh clone has no fixtures. To review the UI without Supabase you must drop the CSV exports into `data/fixtures/` yourself; otherwise point the app at a Supabase project.

## Supabase setup

1. Create/link a Supabase project.
2. Apply **all** migrations in `supabase/migrations/` in filename order (the baseline `20260715101226_create_sourcing_dashboard.sql` first) via the normal Supabase migration workflow. The schema has grown well beyond the baseline — 100+ migrations add the Standard Cost, Buying Plan, PO Closure, Replenishment/DOQ, OOS, and analytics tables.
3. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Vercel.
4. Keep the service-role key out of Next.js. It belongs only in Apps Script Script Properties.

The migration enables RLS on every exposed table, grants authenticated users `SELECT` only, checks the JWT email suffix, and blocks creation of non-`@saadaa.in` users with a database trigger. Supabase’s current Before User Created Hook can be layered on as an earlier rejection point, but the database guard remains authoritative.

## Google Apps Script sync

Copy `apps-script/Code.gs` into the Google Sheet’s bound Apps Script project. In **Project Settings → Script Properties**, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Run `installSyncTriggers()` once while signed in as a sheet owner. It installs:

- `syncAllSheets` every five minutes, which catches `IMPORTRANGE` output changes.
- `onEditSync` as an installable edit trigger for direct manual edits.

To run a manual refresh, select `syncAllSheets` in Apps Script and click **Run**. Each table is upserted in batches and stale rows are soft-deactivated only after all upsert batches succeed. Every run writes row counts/status to `sync_log`.

### Rotate the service-role key

1. Rotate/create the secret key in Supabase project settings.
2. Immediately replace `SUPABASE_SERVICE_ROLE_KEY` in Apps Script Script Properties.
3. Run `syncAllSheets` manually and confirm successful `sync_log` entries.
4. Revoke the old key after verification. Never put this key in a `NEXT_PUBLIC_` variable or source control.

## Data notes

- `pending_qty_actual` is authoritative.
- Vendor joins use `vendor_code`, falling back to normalized name only when the code is missing.
- Rows are keyed on `po_detail_id` when present, otherwise a deterministic SHA-256 legacy key.
  The supplied PO export also carries 1,334 filler rows that are blank apart from a stray
  `TRUE` in the `Match` column. They have no PO identity, so they are skipped outright — left
  in, they all collapse onto one synthetic key and Postgres rejects the whole upsert batch
  ("ON CONFLICT DO UPDATE command cannot affect row a second time"). The dashboard reports how
  many were skipped rather than dropping them silently.
- Sheets error values (`#N/A`, `#REF!`, …) mean "no value", not data. `IMPORTRANGE` emits `#N/A`
  for every cell while a source sheet resolves, so they are coerced to null/0 on both the sync
  and read paths. Passed through as text they read as a completed TNA milestone and push POs
  into the wrong stage.
- A sheet that yields zero usable rows aborts the sync before the stale-row sweep, so a
  mid-refresh `IMPORTRANGE` cannot deactivate every row and blank the dashboard.
- Reads are paginated (1,000 rows/page). PostgREST caps a single response, and
  `pending_po_master` already exceeds that — an unpaginated `select` truncates with no error.
- The changing `No. of Karigar (...)` header is prefix-matched and its literal header is retained.
- Missing vendor-capacity matches are valid and display as zero, rather than failing the dashboard.
- Open PO Tracker rows group by `po_ref_num` + `product_code` + `expected_delivery_date`. The
  spec assumes one EDD per PO, but 11 of 85 open groups carry more than one (e.g.
  `FY26-27/JOB/SDAMK/STN-01` spans 2026-06-01 and 2026-07-31), so each EDD gets its own row.
  KPI and vendor PO counts still count distinct `po_ref_num`, and a PO is flagged delayed if
  any of its lines is overdue.

## Feature status

> This README covers the July 2026 baseline plus the sections below; the app has
> grown to 50+ routes and 100+ migrations since. The authoritative record of what
> is built, deferred, or pending is the git history and the local `docs/PENDENCY.md`
> task log (not committed — see AGENTS.md).

Formerly-blocked features that are **now built**:

- **Urgent Replenishment / DOQ** — live at `/replenishment`, `/doq`, `/doq-dashboard`, `/oos-calculation` (ROP-based; canonical sources `saadaa_inventory_planning` + `saadaa_po_grn_mapping`). Still pending: a channel-level DOQ source and the Quantity-Sold→DOQ sales inflow (surfaced as an explicit gap where absent, not faked).
- **Product State** — the discontinued/ongoing rollup ships via the `product_state_category_rollup` migration and drives the Product Tracker (highest-priority state per category).

## Verification

```bash
npm test
npm run lint
npm run typecheck
npm run build
```
