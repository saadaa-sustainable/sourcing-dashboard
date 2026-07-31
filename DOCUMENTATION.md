# SAADAA Sourcing Dashboard — Complete Documentation

This document describes the entire sourcing dashboard: **where every piece of data comes
from, where it is displayed, and how each field is calculated.** It covers the data
pipeline, every screen/tab, every column, and the exact formulas used.

- **Stack:** Next.js (App Router) frontend, Supabase (Postgres) backend, Google BigQuery
  + Google Sheets/Forms + an EasyCom webhook as upstream sources.
- **Access:** sign-in restricted to `@saadaa.in` Google accounts. Roles: **viewer**
  (read-only), **team** (fill forms, submit, approve routine items), **admin** (approve
  everything, no limits).
- **Deploy:** GitHub → Vercel (production region `bom1` / Mumbai), Supabase project
  `jwqqifojsqcdrlquzwqr`.

---

## 1. Data sources & ingestion pipeline

Three upstream sources feed Supabase. Nothing is typed twice — each source lands in a
dedicated table and everything else is derived from views.

### 1.1 Google BigQuery (`saadaa-wh.MAPLEMONK`) — transactional truth

Pulled by Node scripts in `backfill/` using Application Default Credentials (runs "as
you" via `gcloud auth application-default login`; no service account) and written to
Supabase with the service-role key from `backfill/.env`.

| BigQuery source | Script | Supabase table | Refresh | Upsert key |
|---|---|---|---|---|
| `EE_purchase_orders` + `EE_purchase_orders_po_items` | `backfill/backfill-po.mjs` | `sd_po_master_raw` (raw PO lines, ~64k) | Re-runnable backfill; EasyCom keeps live | `po_detail_id` |
| `saadaa_inventory_planning` | `backfill/sync-extra.mjs` | `sd_inventory_planning` (latest `date_day` snapshot) | Full refresh, mark-and-sweep | `sku\|warehouse` |
| `saadaa_po_grn_mapping` | `backfill/sync-extra.mjs` | `sd_po_grn_mapping` (PO→GRN receipts) | Full refresh, mark-and-sweep | `po_detail_id\|grn_id` |

**PO extraction (`backfill-po.mjs`)** — one row per `purchase_order_detail_id` (latest
by airbyte emit time), joining header + items. Key derivations:
- **SKU shape** `<product_code><2-char colour>_<size>` (e.g. `SDRPTBR_XS`): `product_variant` = everything before the final `_`; `size` = after it; `product_code` = variant minus its last 2 (colour) chars.
- **`po_status_code`**: `2` Waiting, `3` **Approved (in-process)**, `4` Rejected, `5` **Completed**, `7` Cancelled.

Run: `node backfill-po.mjs --test` (5-row sample) / `node backfill-po.mjs` (full).
`node sync-extra.mjs [inventory|grn]` for the other two.

### 1.2 Google Sheets & Google Forms — `apps-script/Code.gs`

An Apps Script bound to the "Production Dashboard" spreadsheet mirrors sheet tabs into
Supabase. **Two triggers:** a **5-minute timer** (`syncAllSheets`) and an **on-edit**
trigger (`onEditSync`). Google **Form** submissions don't fire on-edit, but the 5-minute
timer re-reads the tab and picks them up — so form-backed tabs are covered. Run
`installSyncTriggers()` once to arm both. Requires script properties `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`.

**Sync mechanism:** each run stamps every upserted row with a `sync_token` (a UUID) +
`synced_at` + `is_active=true`, upserts in 500-row batches on the conflict key, then
**mark-and-sweep** deactivates (`is_active=false`) any row whose `sync_token` is stale
(i.e. removed from the sheet). Results are logged to `sync_log`. Header names are
normalised (`lower-case`, non-alphanumeric → `_`, trimmed). Sheet errors (`#N/A`,
`#REF!`, …) are treated as blank. Dates accept `dd/mm/yyyy`, ISO, or Google serial
numbers.

| Sheet tab | Supabase table | Header row | Conflict key | Contents |
|---|---|---|---|---|
| `Pending_PO_MASTER` | `pending_po_master` | 1 | `source_row_key` | Legacy pending-PO mirror (pre-BigQuery) |
| `Vendor_Type_Master` | `vendor_type_master` | 1 | `vendor_name` | Vendor type (Woven/Knit), merchant, status |
| `Vendor Master Data` | `vendor_master_data` | 2 | `vendor_code` | Machines, karigar count, onboarding, capacity/month, contact |
| `TNA Update` | `tna_tracker` | 1 | `po_no` | TNA milestones (6 stages) + roll-ups |
| `PO Details Form` | `po_details_form` | 2 | `source_row_key` | **Google Form** — PO issuance metadata (signed docs, TNA links, critical dates) |

- **`Vendor Master Data`** dynamically finds the latest `no_of_karigar_<date>` column and captures the value + the date label (`karigar_latest`, `karigar_latest_as_of`).
- **`TNA Update`** map reads the 4 core stages plus First Delivery, PO Closer, and roll-ups (`grn_qty`, `pending_qty`, `current_production_stage`, `total_delay_days`); it tolerates the sheet's `po_closer_tna_data` header typo.
- **`PO Details Form`** header is on **row 2** (row 1 is a category-label row). `source_row_key = sha256(timestamp|po_number|easyecom_po_no)` so distinct submissions are kept and exact repeats collapse.

### 1.3 EasyCom webhook — live inventory

`supabase/migrations/20260728_inventory_webhook.sql` adds an Edge Function landing:
`sd_inventory` (current stock per SKU/warehouse, real-time upsert on `sku|warehouse`) and
`sd_inventory_webhook_log` (audit of every call). `sd_inventory_enriched` derives
`product_variant`/`product_code`/`size` from the SKU.

---

## 2. The consolidated PO filter (exclusions)

**`supabase/migrations/20260730_po_filtered_base.sql`** defines a single base view so PO
exclusions can never drift across screens:

```sql
create view sd_po_filtered as
select * from sd_po_master_raw
where warehouse = 'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED'
  and vendor_name not in (
    'SAADAA SUSTAINABLE DESIGNS AND TECHNOLOGIES PRIVATE LIMITED',
    'EBO001', 'Holisol - BLR', 'Marketing SAADAA', 'Defective Goods',
    'SAADAA - GRN', 'HOLISOL-MH');
```

Every PO view derives from `sd_po_filtered` (verified to reproduce the sheet's exact
**3,154 rows / 107 POs**):

| View | Filter | Used by |
|---|---|---|
| `sd_po_dashboard` | `po_status = 'Approved'`; adds `po_type = upper(split_part(po_ref_num,'/',2))` | Main dashboard (all tabs) |
| `sd_po_in_process` | `po_status_code = 3` | Inward Plan, vendor in-process |
| `sd_po_completed` | `po_status_code = 5` | Completed-PO reporting |
| `sd_po_lines_enriched` | all statuses (consumer filters) | Inward Plan, Receivable Plan |
| `sd_po_actuals_by_product_month` | `po_status_code in (3,5)`, `po_date not null` | Buying Plan "actual issued" |
| `sd_vendor_in_process` | rollup of `sd_po_in_process` by vendor | Vendor Capacity, PO approval card |

**`po_type`** is recovered from the PO ref (`FY26-27/FOB/SDRPT/REG-01` → `FOB`); values
are `FOB`, `EFOB`, `JOB`.

---

## 3. Object inventory (tables & views)

**Mirror tables (Sheets/Forms):** `pending_po_master`, `vendor_type_master`,
`vendor_master_data`, `tna_tracker`, `po_details_form`, `sync_log`.
**BigQuery landing:** `sd_po_master_raw`, `sd_inventory_planning`, `sd_po_grn_mapping`.
**Webhook:** `sd_inventory`, `sd_inventory_webhook_log`.
**Workflow tables:** `sd_user`, `sd_buying_plan`, `sd_buying_plan_line`,
`sd_vendor_capacity_log`, `sd_vendor_type_multiplier`, `sd_discontinue_request`,
`sd_po_approval`, `sd_approval_log`, `sd_product_master`, `sd_standard_cost`,
`sd_fabric_master`, `sd_receivable_input`, `sd_vendor_payment_terms`.
**Derived views:** `sd_po_filtered`, `sd_po_dashboard`, `sd_po_in_process`,
`sd_po_completed`, `sd_po_lines_enriched`, `sd_po_actuals_by_product_month`,
`sd_vendor_in_process`, `sd_po_cycle_time`, `sd_po_details`, `sd_active_variants`,
`sd_variant_sales`, `sd_product_sales`, `sd_npd_promotion_candidates`, `sd_replenishment`,
`sd_replenishment_by_product`, `sd_grn_value`, `sd_cash_flow_by_month`, `sd_receivable_plan`,
`sd_material_codes`, `sd_inventory_enriched`.
**Enums:** `sd_role` (viewer/team/admin), `sd_status` (draft/submitted/pending_l2/approved/rejected).

---

## 4. Main dashboard tabs

Files: `src/components/dashboard-shell.tsx` (tabs), `src/lib/business-logic.ts`
(calculations), `src/lib/data.ts` (loading). Data source for all tabs is
**`sd_po_dashboard`** (mapped to `PendingPo` rows via `mapPipelinePo`), joined in-app to
`vendor_type_master`, `vendor_master_data`, and `tna_tracker`. A **All / Woven / Knitted**
filter applies to every tab (Woven = vendor type contains "woven"; everything else = Knit).

### Core definitions (business-logic.ts)

```text
isOpenPo(row)      = pending_qty_actual > 0
delayDays          = max(0, daysBetween(today, EDD))         # never negative
isDelayedPo(row)   = isOpenPo AND daysBetween(today, EDD) > 0
ageingBucket(EDD)  = No EDD | Not Due(0) | 0-7 | 8-15 | 16-30 | 30+   (by delayDays)
```

**TNA_STAGES** (6, in order): PP Sample, GPT, Cutting, Inline/Midline QC (these four are
`core`), then First Delivery, PO Closer (`core:false`). Each stage has a planned
(`*_tna_date`), an actual (`*_actual_date`), and a delay (`*_delay_days`).

```text
deriveTnaStage(tna):
  if current_production_stage set → use it
  else first stage with no actual date (core stages always count; extended only if planned) → "<stage> Pending"
  else "Production";  no record → "Not in TNA Tracker"

isTnaHighRisk(tna): TRUE if ANY stage has a planned date in the past AND no actual date
  (one overdue stage = high risk, regardless of final delivery)

tnaTotalDays = total_delay_days (if ingested)
             else pp + gpt + cutting + inline + first_delivery + po_closer delay days
```

A **tracker row** groups open PO lines by `po_ref_num ⋮ product_code ⋮ EDD` and carries:
`pendingQty = Σ pending_qty_actual`, `pendingValue = Σ pending_qty_actual × item_price`,
plus `delayDays`, `delayBucket`, `stage`, `highRisk`, `variantCount`.

### Tab 1 — Dashboard (overview)
KPI cards + charts over open POs. Cards:
- **Open POs** = count of distinct open `po_ref_num`; sub-note shows SKU-line count.
- **Open Qty** = `Σ pending_qty_actual`.
- **Open Value** = `Σ pending_qty_actual × item_price`.
- **Delayed POs** = distinct delayed refs; note `= delayed/open × 100 %`. Clickable.
- **High Risk POs** = distinct refs with `isTnaHighRisk`. Clickable.

Charts: **PO ageing** (distinct refs per ageing bucket); **Vendor PO status & delay %**
(open vs delayed counts + delay% line, from `buildVendorRollups`); **Top product codes by
pending qty** (top 15); **Product code delay %** (`delayed refs / open refs × 100`);
**Product variant open count** and **variant delay %** (top 15 each).

### Tab 2 — Open PO Tracker
One row per tracker group. Columns: PO ref, Vendor (+code), Product, Variants
(`count distinct variant`), Pending qty, Pending value, EDD, Delay (`delayDays`), Days
Overdue (ageing bucket), TNA stage (`deriveTnaStage`), High risk (`isTnaHighRisk`), TNA
days (`tnaTotalDays`), and all 6 stages' planned+actual dates. Filters: search, vendor,
vendor code, vendor type, PO type, product, merchant, days-overdue bucket. Paginated 25/page.

### Tab 3 — Vendor Performance
`buildVendorRollups` per vendor. Cards: Active vendors (`status = active`), Active with 0
open PO, Total monthly capacity (`Σ capacity_per_month`), Total Open PO Qty. Table:
Open POs (distinct refs), Delayed, **Delay % = delayed/open × 100**, Open qty, Open value,
Machines, Active karigar, Latest karigar, Capacity/mo, **Utilisation = openQty/capacity × 100**.
Plus Woven/Knitted open-vs-delayed charts and a **vendor × PO-type matrix** (cell = Σ
pending qty for that vendor+type).

### Tab 4 — Merchant Performance
Vendor rollups re-aggregated by merchant (owner of the vendor relationship; from vendor
master, else vendor type, else "Unassigned"). Same metrics summed; delay% and
utilisation recomputed on the merchant totals. Sorted by open value.

### Tab 5 — Product Tracker
Two views from `aggregateProductRows`: **Product + Variant** (qty/value per variant) and
**Product Code Summary** (variants count + qty/value per code). `qty = Σ pending_qty_actual`,
`value = Σ pending_qty_actual × item_price`. Filters: search, merchant, vendor, vendor
code, PO type, product, variant. 25/page.

### Tab 6 — Urgent Replenishment (URL `?tab=urgent-replenish`)
- **In Process (365d)** = open tracker rows whose EDD is between today and today+365.
- **Out of Stock** = products where every line has `pending_qty_actual = 0`.
Tables list top products by pending qty and OOS occurrence.

### Tab 7 — Product Matrix View
Grid: rows = product (or product·variant), columns = vendor, cell = `Σ pending_qty_actual`
for that product+vendor. Toggle By Variant / By Product Code. Totals row & column. 25/page.

> Note: a **Vendor Recommendation** tab previously existed and was **removed** on request.

---

## 5. Workflow pages

Files: `src/app/<name>/`. Data access in `src/lib/forms/queries.ts`; server actions in
`src/lib/forms/actions.ts`; approval logic in `src/lib/forms/approval.ts`.

### Approval engine (shared)
```text
ADMIN_THRESHOLD_QTY = 5000
routeApproval(entity, qty, category):
  discontinue, standard_cost         → admin (always)
  po_approval where category in (npd,mat) → admin (always)
  otherwise (buying_plan, FG po)      → qty > 5000 ? admin : team
statusOnSubmit → admin ⇒ 'pending_l2', team ⇒ 'submitted'

RANK: viewer 0, team 1, admin 2
canEdit(role,status)   = status ≠ approved AND role ≥ team
canSubmit(role,status) = status = draft AND role ≥ team
canApprove(role,status)= submitted ⇒ role ≥ team ; pending_l2 ⇒ role = admin
```
Every decision writes `sd_approval_log` (entity, from→to status, actor, notes, timestamp).
`monthStart()` and `weekStart()` compute IST-aware month/Monday boundaries.

### 5.1 Buying Plan (`/buying-plan`) — FG + Material tracks
Monthly buying budget; **Save → Submit → Approve**. Two tabs via `plan-type-tabs.tsx`.

**FG track** reads `sd_buying_plan`/`_line` (`plan_type='fg'`), `sd_active_variants`
(product list), `sd_product_master` (status + Woven/Knitted, read-only), approved
`sd_standard_cost` (rates), `sd_replenishment_by_product` (ROP), and
`sd_po_actuals_by_product_month` (issued). Columns & formulas:
```text
Pending qty      = rop_30 (from Replenishment; no longer typed)
Total qty        = job_work_qty + fob_qty + efob_qty
Standard cost    = Job / FOB / E-FOB (labelled) from approved sd_standard_cost
Value to be bought = job_qty×job_cost + fob_qty×fob_cost + efob_qty×efob_cost
Actual issued qty/value = from sd_po_actuals_by_product_month (this plan month)
Remaining        = max(0, totalQty − actualQty)
% complete       = min(100, round(actualQty/totalQty × 100))
Over-plan (red, non-blocking) = actualQty > totalQty
```
Status/fabric are stored as a snapshot on each line. View mode groups by Woven/Knitted
with progress bars + an overdue filter (remaining>0 and >7 days into the month). Routing:
FG ≤5000 → team, >5000 → admin.

**Material track** (`material-plan-client.tsx`) reads `sd_material_codes` (fabric
datalist from `sd_fabric_master`). Columns: material code, quantity, UOM
(metres/kg/pcs/rolls/sets), rate, **value = quantity × rate**. Routing: any qty → team.

### 5.2 Replenishment / DOQ (`/replenishment`) — read-only
Reads `sd_replenishment` (per colour) / `sd_replenishment_by_product`. Formulas (in-DB):
```text
daily_demand = coalesce(nullif(daily_quantity,0), t45_quantity/45.0, 0)
rop_N        = max(0, daily_demand×N − current_stock − in_progress)   for N = 30/60/90
oos_flag     = any oos_days_45 > 0
```
Columns: variant, product, state, current stock, in-process, daily demand, DOQ-45, OOS,
ROP 30/60/90. Feeds the Buying Plan's Pending qty (30-day).

### 5.3 Standard Cost (`/standard-cost`) — Save → Submit → Approve (admin)
`sd_standard_cost`: `job_cost`, `fob_cost`, `efob_cost` per product. Approved rows feed
the Buying Plan. **Frozen** = locked at first PO issuance **only if** the issuer ticks
"set as standard benchmark cost" (explicit lock-in, never silent). Editing a frozen or
approved row is blocked. Always routes to admin.

### 5.4 Vendor Capacity (`/vendor-capacity`) — per-vendor save, no approval
Reads `sd_vendor_capacity_log` (one live row per vendor), `sd_vendor_type_multiplier`,
vendor master, `sd_vendor_in_process`. **LIVE** (editable): machines allotted, active
karigar, capacity/month. **FIXED** (from master): type, machines at onboarding, capacity
signed. Formulas:
```text
PO capacity = capacity_per_month × type multiplier   (Job ×1.0, E-FOB ×1.5, FOB ×2.5)
Available   = PO capacity − in-process qty      (negative ⇒ "over production")
Stale       = entry_date older than 7 days
```
(`sd_vendor_type_multiplier`: job_work ×1.00 / 30d, efob ×1.50 / 41d, fob ×2.50 / 75d.)
Each row saves independently (`saveVendorCapacityRow`, upsert on `vendor_code`, stamps
`entry_date`). A **Stale only** filter and oldest-first sort surface neglected vendors.

### 5.5 PO Approval (`/po-approval`) — raise, gate, approve, issue
`sd_po_approval` (18 inputs + approval + issuance fields) with `sd_po_cycle_time`,
`sd_vendor_in_process` and latest capacity on the approval card. Inputs: category
(FG/MAT/NPD), PO type, product, PO ref (Suggest builds `FY../TYPE/PRODUCT/VENDOR-`),
vendor, TNA/cost sheet URLs, PO qty, closing date, CAD folder (E-FOB), critical-stage
dates (PP/GPT/Cutting/Inline), first delivery, trim card, buying plan no.

**Routing:** FG ≤5000 team / >5000 admin; MAT & NPD always admin.
**TNA gate (hard):** `confirmTna` (approver-only) locks the critical-path dates
(`tna_confirmed`); `decideApproval` **blocks cost approval** until `tna_confirmed=true`.
The team's dates are "proposed" until the approver reviews and confirms.
**Issuance:** on an approved PO, enter the EasyCom PO no. (mapping key) + DiGiO signed
docs; optional benchmark lock-in freezes the standard cost.
**Cycle-time KPI** (`sd_po_cycle_time`), shown as a rolling-average strip + per-PO:
```text
days_to_approve = approved_at − submitted_for_approval_at   (days)
days_to_issue   = po_issued_at − approved_at
days_to_sign    = date_of_po_sign − approved_at              (vendor sign-off leg)
total_cycle_days / total_cycle_days_signoff = end-to-end
```
This is distinct from TNA-stage production delays.

### 5.6 PO Details (Form) (`/po-details`) — read-only
Reads `sd_po_details` (from the `po_details_form` Google Form mirror). Shows the sourcing
**issuance metadata** (signed PO/cost/TNA docs, TNA sheet + CAD links, critical-stage
dates, colours, buying-plan no.). **GCP/EasyEcom remain the source of truth** for the PO
itself; `matched_to_live_po` flags whether the ref is still an open Approved PO
(`form.po_number = GCP po_ref_num`). Filters: All / In-pipeline / Not-in-pipeline; doc
links open Drive files.

### 5.7 Inward Plan (`/inward-plan`) — read-only
`sd_po_lines_enriched` where `po_status_code=3` and `pending_qty>0`, grouped by
`po_number·product·variant`. Columns: PO, ref, product, colour, vendor, Ordered qty
(`Σ original_qty`), **Arriving qty (`Σ pending_qty`)**, earliest EDD. Sorted soonest-first.

### 5.8 Receivable Plan (`/receivable-plan`) — read + weekly input
`sd_receivable_plan` (open PO lines pivoted by size XS…5XL, joined to inventory
`product_state`/`doq_45`/`current_stock`/`oos_flag`) merged with editable
`sd_receivable_input` (delivery date this week, qty expected, remarks) keyed
`po_number|product_variant`. Team+ can edit; save is per-row on change.

### 5.9 Cash Flow (`/cash-flow`) — read + editable terms
`sd_cash_flow_by_month`: forward payment obligations. Two legs:
```text
received (invoiced) : due = coalesce(grn_invoice_date, grn_created_date) + terms
                      amount = sd_grn_value.grn_value  (= max(total_grn_value) per grn_id)
projected (open PO)  : due = coalesce(expected_delivery_date, po_date) + terms
                      amount = pending_qty × item_price   (from sd_po_dashboard)
terms = sd_vendor_payment_terms.payment_terms_days (default 45)
```
Grouped by month & source. `sd_grn_value` takes `max(total_grn_value)` per `grn_id`
because that column is a GRN-header total repeated on every line. Vendor terms are
editable (`saveVendorTerms`) and recompute the forecast.

### 5.10 Discontinue (`/discontinue`) — 3-scope, admin approval
`sd_discontinue_request`, scopes **product / colour / size**. A partial unique index
allows only one live (non-rejected) request per target. Always routes to admin. Approved
requests drop the item from `sd_active_variants`, so it disappears from the Buying Plan
and stops counting as in-process.

### 5.11 Approvals (`/approvals`) — unified queue + audit
Aggregates all `submitted`/`pending_l2` items across buying_plan, discontinue,
po_approval, standard_cost, tagged with the required role (`routeApproval`). PO items also
show live vendor in-process qty + capacity. "Mine" filters to what the current user can
approve. Shows the last 100 `sd_approval_log` entries (when, record, from→to, actor, notes).

---

## 6. Admin pages

### 6.1 Product Master (`/product-master`)
`sd_product_master` (`product_code` PK): `product_status`
(Active/Inactive/TBD/NPD/NPD-Not-Launched/Ongoing/Discontinued) and `fabric_type`
(Woven/Knitted), read-only in the Buying Plan. Status is derived from
`inventory_planning.product_state` (most-common per product). Includes a **Suggested NPD
promotions** panel: `sd_npd_promotion_candidates` = NPD-Not-Launched products with any
colour selling >50 pcs in 45 days.

### 6.2 Fabric Master (`/fabric-master`)
`sd_fabric_master` (`fabric_code` PK, manual): composition, warp/weft count, third
thread/blend, weave, GSM, raw material/colour, name. **Duplicate prevention** is the
point: `addFabric` inserts and **blocks** an existing code (Postgres `23505`);
`updateFabric` edits in place. The Buying Plan material datalist (`sd_material_codes`)
reads from here.

### 6.3 Users (`/users`)
`sd_user` (`email` PK): name + role (viewer/team/admin) + active flag. Anyone signing in
who isn't listed defaults to **viewer**. Admin-managed.

---

## 7. Roles, security & refresh

**RLS:** every table/view is readable by `@saadaa.in` (`sd_is_saadaa()`); writes require
`sd_can_write()` (team/admin). Sync scripts & webhooks use the service role (bypass RLS).

**Refresh cadence:**

| Source | Mechanism | Frequency |
|---|---|---|
| BigQuery PO (`sd_po_master_raw`) | `backfill-po.mjs` | Backfill / scheduled |
| BigQuery inventory | `sync-extra.mjs` | ~Daily (latest snapshot) |
| BigQuery GRN | `sync-extra.mjs` | ~5 min |
| Google Sheets + Forms (5 tabs) | Apps Script | 5-min timer + on-edit |
| EasyCom inventory | Edge Function webhook | Real-time |
| App workflows | user actions | Immediate |

**Operational setup required for live data:** run `installSyncTriggers()` once in the
Apps Script project; schedule the BigQuery sync jobs; set user roles in `sd_user`; approve
standard costs so the Buying Plan shows values.

---

## 8. Formula quick-reference

```text
delayDays            = max(0, daysBetween(today, EDD))
ageing               = No EDD | Not Due | 0-7 | 8-15 | 16-30 | 30+
high risk            = any TNA stage planned-date passed with no actual
delay %              = delayed refs / open refs × 100
utilisation %        = open qty / capacity_per_month × 100
PO capacity          = capacity_per_month × {Job 1.0, E-FOB 1.5, FOB 2.5}
available capacity   = PO capacity − in-process qty
daily_demand         = coalesce(nullif(daily_quantity,0), t45_quantity/45, 0)
rop_N                = max(0, daily_demand×N − current_stock − in_progress)
buying value         = job_qty×job_cost + fob_qty×fob_cost + efob_qty×efob_cost
material value       = quantity × rate
cash due (received)  = coalesce(grn_invoice_date, grn_created_date) + terms
cash due (projected) = coalesce(EDD, po_date) + terms  ; amount = pending_qty×item_price
grn value            = max(total_grn_value) per grn_id
cycle days_to_approve= approved_at − submitted_for_approval_at
cycle days_to_sign   = date_of_po_sign − approved_at
po_type              = upper(split_part(po_ref_num, '/', 2))
approval routing     = FG ≤5000 team / >5000 admin ; MAT, NPD, discontinue, std-cost → admin
```

---

*Generated for the SAADAA sourcing dashboard. For field-level help inside the app, each
workflow screen has an in-context help panel (`src/components/forms/form-help.tsx`).*
