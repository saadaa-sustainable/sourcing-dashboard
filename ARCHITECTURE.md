# Architecture

## Overview and purpose

The SAADAA Sourcing Dashboard is an internal reporting tool for the sourcing team. It
turns the raw Google Sheets that the operations team maintains — open purchase orders,
vendor type/capacity masters, and a TNA (Time-and-Action) tracker — into an analytical
dashboard covering open PO tracking, vendor and merchant performance, TNA stage mapping,
product rollups, and product/vendor matrices.

Data is authored in Google Sheets, pushed into Supabase Postgres by a Google Apps Script
sync, and read back by a Next.js app that computes all KPIs and matrices at request time.
The app never writes to the business tables; the sheets remain the source of truth.

## Tech stack

- **Next.js 16** (App Router, React 19, React Server Components) — `next.config.ts` is
  intentionally empty; the app relies on framework defaults.
- **TypeScript 5** with `strict` mode. Path alias `@/*` → `src/*` (`tsconfig.json`).
- **Supabase** — Postgres for storage, Supabase Auth for sign-in, PostgREST for reads.
  `@supabase/ssr` provides cookie-based sessions across Server Components and the proxy.
- **Tailwind CSS 4** via `@tailwindcss/postcss` (`postcss.config.mjs`); global styles in
  `src/app/globals.css`.
- **recharts** for charts, **lucide-react** for icons.
- **Google Apps Script** (`apps-script/Code.gs`) for the sheet → Supabase sync.
- Tooling: ESLint 9 (`eslint-config-next`), `tsx` test runner (Node's built-in `node:test`).
- **Node 22.13+** required (`engines` in `package.json`, `.nvmrc`).

## Directory layout

```
apps-script/Code.gs        Google Apps Script sheet -> Supabase sync (runs in Sheets, not the app)
supabase/
  config.toml              Supabase CLI local-stack config (project id "Sourcing_Dashboard")
  migrations/              Ordered SQL migrations (schema + RLS policy history)
public/                    Static SVG assets (Next.js starter icons)
src/
  proxy.ts                 Next "middleware" (proxy) — refreshes the Supabase session per request
  app/                     App Router
    layout.tsx             Root layout, fonts (Inter + Space Grotesk), metadata
    page.tsx               Home: auth guard -> loadDashboardData() -> <DashboardShell>
    loading.tsx            Route-level loading fallback
    error.tsx              Route-level error boundary
    globals.css            Global styles / design tokens
    login/
      page.tsx             Login screen (email/password form + Google button)
      actions.ts           `login` server action (password sign-in, @saadaa.in guard)
      google-button.tsx    Client button that starts Google OAuth
    auth/callback/route.ts OAuth callback: exchange code for session, enforce @saadaa.in
  components/
    dashboard-shell.tsx    The entire client dashboard UI (tabs, KPIs, charts, tables, CSV export)
  lib/
    types.ts               Row types (PendingPo, VendorType, VendorMaster, TnaRecord) + derived types
    data.ts                Data loader: Supabase (paginated) or CSV fixtures fallback
    business-logic.ts      Pure KPI/rollup/stage logic (open PO, delay, TNA stage, vendor rollups)
    business-logic.test.ts Unit tests for business-logic
    sheet-values.ts        Coercion of raw sheet values (errors -> null, dd/mm/yyyy dates, etc.)
    sheet-values.test.ts   Unit tests for sheet-values
    csv.ts                 CSV parser (RFC-4180-ish) + header normalisation for fixtures
    download.ts            Client-side CSV export (RFC 4180 + BOM for Excel)
    supabase/
      server.ts            Server-side Supabase client (cookie-bound) + hasSupabaseEnv()
      client.ts            Browser Supabase client
      proxy.ts             updateSession(): session refresh used by src/proxy.ts
```

Note: `src/components/dashboard-shell.tsx.bak` is a stray backup and is not part of the build.

## Data model (Supabase / migrations)

All business tables live in the `public` schema and are populated exclusively by the Apps
Script sync running as the service role. Migrations are applied in filename order.

`20260715101226_create_sourcing_dashboard.sql` (baseline schema):

- **`pending_po_master`** — one row per open-PO line. Keyed by `source_row_key` (unique):
  `po_detail_id` when present, otherwise a deterministic `legacy:<sha256>` key derived from
  `po_ref_num|sku|cp_id|po_id|size`. Carries `pending_qty_actual` (authoritative pending
  quantity), `item_price`, vendor identity, `expected_delivery_date`, `product_code`,
  `product_variant`, `po_type`, `match_flag`. Indexed on `po_ref_num`, `vendor_code`,
  `product_code`, and a partial index on `is_active`.
- **`vendor_type_master`** — keyed by `vendor_name`. Maps vendor → `vendor_type`
  (Woven/Knit), `merchant_name`, `status`.
- **`vendor_master_data`** — keyed by `vendor_code`. Capacity data: `total_machines`,
  `total_active_karigar`, `machines_for_saadaa`, `capacity_per_month`, plus the latest
  karigar count and the literal "as of" header it came from.
- **`tna_tracker`** — keyed by `po_no`. TNA milestone TNA/actual dates and delay days for
  PP Sample → GPT → Cutting → Inline/QC stages.
- **`sync_log`** — append-only audit trail of each sync run (rows synced/deleted, status,
  error, timestamps).

Every table has the sync-support columns `is_active`, `sync_token`, and `synced_at`. Reads
filter on `is_active = true`; stale rows are soft-deactivated (never hard-deleted).

### Security model

The baseline migration enables RLS on every table, `REVOKE`s all from `anon`/`authenticated`,
then `GRANT`s `SELECT` only to `authenticated`, behind policies that require the JWT `email`
to end in `@saadaa.in`. The service role bypasses RLS for sync writes. A trigger on
`auth.users` originally blocked creation of non-`@saadaa.in` accounts.

RLS policy history (see `migrations/`):

- `20260717120000_open_dashboard_access.sql` — dropped the domain trigger and relaxed
  policies to any authenticated user.
- `20260717150000_restore_saadaa_only_access.sql` — restored `@saadaa.in`-only read
  policies. The `auth.users` trigger is intentionally **not** recreated (the `auth` schema
  is locked); domain enforcement now lives in the app layer instead: the password login
  guard, the Google OAuth callback, the dashboard page guard, and the RLS policies.

## The Apps Script integration

`apps-script/Code.gs` is copied into the bound Apps Script project of the source Google
Sheet. It is the only writer of the business tables and talks to Supabase via PostgREST
using the service-role key (stored in Script Properties, never in the Next.js app).

- Everything is sealed inside one namespace (`SbSync_`); only `syncAllSheets`, `onEditSync`,
  and `installSyncTriggers` are global, so it can coexist with other bound scripts.
- `installSyncTriggers()` arms a 5-minute time-based `syncAllSheets` (catches `IMPORTRANGE`
  updates) plus an installable on-edit trigger.
- Per sheet it reads display values, normalises headers, maps rows, **dedupes by the conflict
  key** (Postgres rejects an upsert batch that touches the same conflict target twice),
  upserts in 500-row batches with `resolution=merge-duplicates`, then **soft-deactivates
  stale rows only after all batches succeed**. Every run writes to `sync_log`.
- Sheet error sentinels (`#N/A`, `#REF!`, …) are coerced to null/0, and a sheet yielding
  zero usable rows aborts before the stale sweep — so a still-resolving `IMPORTRANGE` can
  never blank the dashboard.

The read-path coercion in `src/lib/sheet-values.ts` deliberately mirrors this Apps Script
logic so fixtures and live data behave identically.

## Data flow

1. Ops team maintains Google Sheets (some tabs pull from other sheets via `IMPORTRANGE`).
2. Apps Script sync upserts each sheet into its Supabase table and deactivates stale rows.
3. A user hits `/`. `src/proxy.ts` (`updateSession`) refreshes the Supabase session cookie.
4. `app/page.tsx` (a Server Component, `dynamic = 'force-dynamic'`) reads the JWT claims,
   redirects to `/login` if unauthenticated, and rejects non-`@saadaa.in` emails.
5. `loadDashboardData()` in `lib/data.ts` reads all four tables. Because PostgREST caps a
   response at ~1000 rows and `pending_po_master` exceeds that, reads are **paginated**
   (1000 rows/page, `is_active = true`, stable sort).
6. When Supabase env vars are absent, the loader falls back to CSV fixtures in
   `data/fixtures/`, letting the full UI be reviewed locally without a database.
7. `DashboardShell` (client) runs the pure functions in `lib/business-logic.ts` to build
   tracker rows, vendor/merchant rollups, product aggregates, and TNA stages, then renders
   tabs, KPIs, recharts visualisations, and tables. CSV export is client-side via
   `lib/download.ts`.

### Key business rules (see `lib/business-logic.ts`)

- **Open PO** = `pending_qty_actual > 0` (authoritative). **Delayed** = open and EDD in the
  past. **High-risk** = open, nothing received yet, EDD within 15 days.
- Open PO groups are keyed on `po_ref_num` + `product_code` + `expected_delivery_date`
  (a PO can carry more than one EDD, so EDD is part of the key). KPI/vendor PO counts still
  count distinct `po_ref_num`.
- Vendor resolution joins on `vendor_code`, falling back to normalised `vendor_name`.
- TNA stage is the first milestone whose actual date is missing (PP Sample → GPT → Cutting →
  Inline/QC), else "Production"; POs absent from the tracker are "Not in TNA Tracker".

### Dashboard tabs

Dashboard, Open PO Tracker, Vendor Performance, Vendor Type, Merchant Performance, Product
Tracker, Urgent Replenishment, Vendor Recommendation, Product Matrix View. Urgent
Replenishment / DOQ and Product State are surfaced as explicit "source pending" states
because their upstream feeds (daily opening inventory + sales history, and the BigQuery
FSTR discontinued/ongoing feed) are not yet available — no placeholder math is computed.

## Build, run, and deploy

Local development (Node 22.13+):

```bash
npm install
copy .env.example .env.local   # cp on macOS/Linux
npm run dev
```

Without Supabase env vars the app runs on CSV fixtures. With both public Supabase vars set,
authenticated live reads become mandatory.

Environment variables:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- The **service-role key** never touches Next.js — it lives only in Apps Script Script
  Properties (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`).

Scripts (`package.json`):

- `npm run dev` / `npm run build` / `npm start`
- `npm run lint` — ESLint
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — `tsx --test` over `sheet-values.test.ts` and `business-logic.test.ts`

Deployment target is Vercel; Supabase migrations are applied through the standard Supabase
migration workflow, and the Apps Script sync is installed once in the source sheet.
