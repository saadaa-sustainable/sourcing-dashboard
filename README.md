# SAADAA Sourcing Dashboard

Production-oriented migration of the Sourcing Dashboard to Next.js 16, Supabase, and Vercel. It covers open PO tracking, vendor and merchant performance, TNA stage mapping, product rollups, and product/vendor matrices.

## Local setup

Requires Node 22.13+.

```bash
npm install
copy .env.example .env.local
npm run dev
```

Without Supabase environment variables, the app uses the supplied CSV exports in `data/fixtures` so the complete UI can be reviewed locally. With both public Supabase variables configured, authentication and live RLS-protected reads are mandatory.

## Supabase setup

1. Create/link a Supabase project.
2. Apply `supabase/migrations/20260715101226_create_sourcing_dashboard.sql` using the normal Supabase migration workflow.
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

## Blocked features

- **Urgent Replenishment / DOQ** — waiting for daily opening inventory and sales history. Available-day calculations must exclude inventory ≤3 and count available days, not calendar days. No placeholder calculation is implemented.
- **Product State** — waiting for Harsh’s BigQuery FSTR discontinued/ongoing feed. No placeholder state is implemented.

Both appear as explicit source-pending states in Product Tracker.

## Verification

```bash
npm test
npm run lint
npm run typecheck
npm run build
```
