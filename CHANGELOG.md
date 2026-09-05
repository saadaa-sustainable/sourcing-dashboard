# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

> **Note (2026-09-05):** This changelog was maintained in detail only through the
> v1.0.0 baseline (2026-07-21). Roughly six weeks and 100+ migrations of feature
> work followed and are **not** itemised here. The authoritative record is the git
> history and the local `docs/PENDENCY.md` task log. The high-level summary below
> replaces the earlier (now inaccurate) "blocked" section.

### Added since 1.0.0 (high level — see git log for detail)

- **Standard Cost** module (rate history, approval flow, EFOB/fabric cost, CMTP gating).
- **Buying Plan** rebuild (FG + Fabric/Material + Inward Plan II tracks, category grouping,
  time-bucketed coverage, partial line-item approval).
- **PO Closure** (cutting register, dynamic links, surplus, SLA, compliance dashboard).
- **Urgent Replenishment / DOQ / OOS** — now built (`/replenishment`, `/doq`,
  `/doq-dashboard`, `/oos-calculation`), superseding the earlier "blocked" state. Still
  pending: channel-level DOQ source and the sales-quantity inflow (shown as a gap, not faked).
- **Product State** rollup (discontinued/ongoing, category priority) — superseding the
  earlier "blocked" state.
- **Vendor Capacity**, **Vendor Recommendation**, **cross-tab analytics cards**, **custom
  roles / view-set access**, **manual data ingestion**, toasts / sync monitor, and more.

### Security

- Fixture mode now **fails closed in production**: a deploy missing Supabase env throws
  instead of serving a no-login admin dashboard (`isFixtureMode()`).
- GRN webhook capture-first mode bounded (1 MB cap + `GRN_CAPTURE_UNAUTHED` sunset switch).

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
