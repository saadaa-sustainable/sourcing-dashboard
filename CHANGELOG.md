# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Blocked / pending upstream data

- **Urgent Replenishment / DOQ** — awaiting daily opening inventory and sales history.
  Available-day calculations must exclude inventory ≤3 and count available days (not
  calendar days). Surfaced as an explicit source-pending state; no placeholder is computed.
- **Product State** — awaiting the BigQuery FSTR discontinued/ongoing feed. Surfaced as a
  source-pending state in Product Tracker; no placeholder state is computed.

## [1.0.0] - 2026-07-21

Production-oriented migration of the Sourcing Dashboard to Next.js 16, Supabase, and Vercel.
This baseline entry describes the current state of the codebase.

### Added

- **Next.js 16 App Router app** (React 19, TypeScript strict) rendering the sourcing
  dashboard: KPIs, open PO tracker, vendor/merchant performance, TNA stage mapping, product
  rollups, vendor recommendation, and product matrix views across nine tabs
  (`src/components/dashboard-shell.tsx`).
- **Supabase-backed data layer** (`src/lib/data.ts`) with paginated (1000 rows/page) reads
  of `pending_po_master`, `vendor_type_master`, `vendor_master_data`, and `tna_tracker`,
  filtered to `is_active` rows.
- **CSV fixture fallback** — when Supabase env vars are absent, the full UI runs on the
  exports in `data/fixtures/` for local review.
- **Authentication** — email/password login and Google OAuth via Supabase, with
  `@saadaa.in` domain enforcement at the login guard, OAuth callback, page guard, and RLS
  (`src/app/login/*`, `src/app/auth/callback/route.ts`, `src/proxy.ts`).
- **Supabase schema and RLS** (`supabase/migrations/20260715101226_create_sourcing_dashboard.sql`):
  read-only reporting tables, `sync_log` audit table, RLS with `SELECT`-only grants to
  authenticated users, and an `auth.users` domain-enforcement trigger.
- **Google Apps Script sync** (`apps-script/Code.gs`): namespaced sheet → Supabase upsert
  with 5-minute and on-edit triggers, per-key dedupe, batched upserts, safe stale-row
  soft-deactivation, and `sync_log` reporting.
- **Pure business logic** (`src/lib/business-logic.ts`): open/delayed/high-risk PO rules,
  ageing buckets, TNA stage derivation, vendor/merchant/product rollups. Covered by unit
  tests run with `tsx --test`.
- **Robust sheet-value coercion** (`src/lib/sheet-values.ts`, `src/lib/csv.ts`): spreadsheet
  error sentinels (`#N/A`, `#REF!`, …) coerced to null/0, `dd/mm/yyyy` date parsing with
  round-trip validation, and prefix-matched dynamic karigar headers.
- **Client-side CSV export** with Excel-friendly BOM (`src/lib/download.ts`).

### Security

- Row-Level Security enabled on all business tables; authenticated users have `SELECT` only.
  The service role (used only by Apps Script, key kept out of Next.js) bypasses RLS for sync
  writes.
- Data access restricted to `@saadaa.in` accounts across the auth and data layers
  (`supabase/migrations/20260717150000_restore_saadaa_only_access.sql`).

### Changed

- Access policy iterated during setup: `20260717120000_open_dashboard_access.sql` briefly
  opened reads to any authenticated user, then `20260717150000_restore_saadaa_only_access.sql`
  restored `@saadaa.in`-only access. Because the `auth` schema is locked, the original
  `auth.users` domain trigger was not recreated; domain enforcement now lives in the app.

[Unreleased]: https://keepachangelog.com/en/1.1.0/
[1.0.0]: https://keepachangelog.com/en/1.1.0/
