# PO Closure & Cutting Register — spec

Source: feature spec (Aug 2026). Canonical reference for the PO Closure workflow.
Records intent + the **resolutions** where the original spec assumed infra that
doesn't exist in this codebase.

Related code: `supabase/migrations/20260831120000_po_closure.sql`, `src/app/po-closure/`
(to build), `src/app/fill/[token]/` (public route, to build).

## Why this exists
PO closure is manual and slow: sourcing hand-enters scattered sheets, finance
re-keys into Busy, and nobody tracks how long a completed PO sits open. This makes
closure a **gated, two-leg, SLA-tracked** workflow with a **no-login capture** path
(tokenized dynamic links) so vendors / field staff outside the dashboard can submit
data.

## Resolutions vs. the original spec (important)
- **No FK to `sd_po_dashboard`.** It's a **view**, and `po_ref_num` isn't unique in
  it. `po_ref_num` is stored as plain **`text`, no FK** (matches `sd_po_approval`).
- **Completion detected from `sd_po_master_raw`**, not `sd_po_dashboard` — the view
  is filtered to `po_status='Approved'`, so Completed POs (`po_status_code=5`) never
  appear in it.
- **BOM added to `sd_product_master`** (`bom_quantity`, `bom_uom`) — there was **no
  BOM data** anywhere; the team fills it like the other masters. `surplus = actual −
  bom` only when bom is present; missing bom shows "No BOM on file" (never 0).
- **Email deferred.** No email sender exists in the codebase. v1 delivery is
  **WhatsApp share (`wa.me`) + copy-link** only. Email is a later phase.
- **Anon never reads the tables.** The public `/fill` route calls a
  `SECURITY DEFINER` validator (`sd_validate_dynamic_link`) — no table enumeration.
- **No auth middleware** exists; routes gate themselves in server components, so the
  public `/fill/[token]` route simply omits the `currentUser()`/redirect check.
- **Name clash resolved.** An earlier migration already had a lightweight
  `sd_po_closure` (per-PO Yes/No decision, `po_number` PK, via `setPoClosure()` /
  the submission table's `closureStatus`). It was empty (0 rows) → renamed to
  **`sd_po_closure_decision`** (its 2 code refs repointed); the rich workflow takes
  the `sd_po_closure` name.

## Schema (built — §1)
`sd_dynamic_links`, `sd_cutting_register`, `sd_po_closure` (+ bom cols on
`sd_product_master`). RLS = standard `@saadaa.in` read / `sd_can_write` write on all
three. `sd_validate_dynamic_link(token)` SECURITY DEFINER, granted to `anon`.
Invalid/expired/inactive/already-submitted all collapse to `is_valid=false` (no
reason leaked).

## Behaviour (to build)
- **§2 Dynamic links** — server-action token gen (`crypto.randomBytes(24).base64url`);
  `expires_at = min(created+30d, easycom_completed_at+15d)` (SLA cap), or created+30d
  if not completed yet. `/fill/[token]` public route: validate → render cutting form
  (pre-filled po/product/BOM + required submitter name + email/phone) → submit via a
  DEFINER function that inserts the register row and marks the link single-use
  (`submitted_at`, `is_active=false`). WhatsApp share + copy link shown together;
  Revoke Link action (`is_active=false`).
- **§3 BOM auto-populate** — snapshot `sd_product_master.bom_quantity`/`bom_uom` into
  `sd_cutting_register` at creation (both paths). Show read-only next to actual input.
- **§4 Surplus** — `surplus_fabric_qty = actual − bom_standard_qty` (null if bom null,
  flag for review). `surplus_fabric_value = qty × fabric standard cost` (from
  `sd_standard_cost`; null if unavailable). Trigger recomputes + propagates to
  `sd_po_closure`. Finance can override.
- **§5 Gating + SLA** — "Initiate Closure" only when `po_status_code=5` (server- +
  client-enforced, read from raw). Stamp `easycom_completed_at` on completion (create
  the closure row then, so the SLA clock starts at completion). Two legs: sourcing
  submit → finance submit (`closed_at`). SLA: merchandiser ≤7d, finance ≤7d, total
  hard cap 15d; `compliance_status` on_time/breached, real-time for still-open POs.
- **§5-7 Views** — PO Closure Compliance dashboard (RAG, days-elapsed, leg status),
  "open beyond 15 days" filter, per-person breakdown (initiated_by /
  sourcing_submitted_by / finance_submitted_by), and a Closure badge on Open PO
  Tracker once Completed.

## Implementation notes (built)
- **Completion detection** — `sd_sync_po_closures()` (SECURITY DEFINER, granted to
  authenticated) creates closure rows for SAADAA completed POs (same working-set
  filter as the view) in a **rolling 45-day window** (3× the SLA cap). Forward-looking:
  retro-creating rows for POs completed months ago would only add stale breaches.
  `easycom_completed_at = max(po_updated_date)` so the clock starts at completion.
  Called on each PO Closure page load (idempotent).
- **Surplus** computed in `submitSourcingLeg` (not a trigger — value needs the
  standard-cost lookup): qty = actual − BOM (null if BOM missing), value = qty ×
  finished-fabric cost (`product → sd_standard_cost.fabric_code → sd_fabric_cost_base`).
  Finance can override the value on the finance leg.
- **SLA** — `computeClosureCompliance` (pure, in `business-logic.ts`, unit-tested):
  merch ≤7d, finance ≤7d, total cap 15d; RAG is real-time (open POs past 15d read red).
- **Gate** — closure rows exist only for completed POs, so "Initiate" / legs are
  inherently gated; `initiateClosure` also re-checks `easycom_completed_at`.
- **PO Closure screen** (`/po-closure`): metric row, RAG table, "open beyond 15 days"
  filter, per-person breach breakdown, inline two-leg forms.

## Build order
1. Schema ✅ · 2. BOM auto-populate ✅ · 3. Cutting Register form ✅ ·
4. Dynamic link gen + `/fill/[token]` ✅ · 5. Surplus ✅ · 6. Gating + two-leg + SLA ✅ ·
7. Compliance dashboard ✅ · **Deferred:** Closure badge on Open PO Tracker (small
follow-up — surface `sd_po_closure` status on the tracker rows).

## Out of scope (this pass)
Automated WhatsApp API sending; multi-submission links (single-use only);
ERP/Busy integration (challan/debit-note entered manually); per-karigar surplus
benchmarking beyond BOM-vs-actual.
