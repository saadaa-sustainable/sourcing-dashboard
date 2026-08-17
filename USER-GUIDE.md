# SAADAA Sourcing Dashboard — User Guide

A plain-language guide for the sourcing, merchandising and warehouse teams. It covers
what each screen is for, how to use it, what every number means, and the questions that
come up most. For the technical/data-pipeline details see `DOCUMENTATION.md`.

> **Tip:** every screen has a **"What do these mean?"** button (top-right). It explains
> each field and shows the **exact formula** for every calculated value. This guide is the
> overview; that button is the field-level reference.

---

## 1. Getting started

- **Sign in** with your `@saadaa.in` Google account. Access is restricted to SAADAA accounts.
- **What you can do depends on your role:**

| Role | Can do |
|---|---|
| **Admin** (founders) | Everything — fill forms, submit, and **approve** anything. |
| **Team** (supply chain) | Fill/submit forms, approve routine items (small POs, buying plans). |
| **Viewer** | Read-only. |

- The left sidebar has three groups: **Workspace** (analytics tabs), **Workflows** (the forms
  you fill), and **Admin** (masters + users).

---

## 2. How fresh is the data?

Most screens read live business data that syncs on a schedule — you don't refresh anything.

| Data | Refreshes |
|---|---|
| POs, GRN receipts (tracker, actuals, cash flow) | **6 AM & 6 PM** daily |
| Inventory snapshot (DOQ, stock, OOS) | **6 AM** daily |
| Vendor QC / rejection (Vendor Recommendation) | **6 AM** daily |
| Google Sheet / Form data (TNA stages, PO details) | every ~5 minutes |
| Anything you type (plans, costs, capacity, receivables) | **instant** |

So a PO raised or received today shows up at the next 6 AM/6 PM sync — the planning
screens aren't meant to be real-time.

---

## 3. The approval flow (used by Buying Plan, Standard Cost, PO Approval, Discontinue, Receivable)

Everything approvable follows the same path:

**Draft → Submit → Approve** (or send back).

- **Save** keeps a draft you can keep editing. **Submit for approval** locks it and sends it
  to the Approvals queue. Small/routine items route to **Team**; large ones and NPD/Material
  route to **Admin**.
- Statuses you'll see:
  - **Draft** — being filled.
  - **Approval Pending** — submitted, waiting on an approver.
  - **First-Time Approved** — approved with no changes.
  - **Edited-and-Approved** — an approver tweaked it before approving.
  - **Rework-and-Reassign** — sent back to fix (a **remark is required**); edit and re-submit.
  - **Rejected** — declined with a reason.
- **Partial approval:** on a Buying Plan, an approver can tick **individual lines** (or "select
  all") and approve just those — the plan only flips to Approved once **every** non-zero line is
  approved. So the Woven lines can be approved while Knitted is still under review.
- An **approved** item is **locked**. To change it, pick another month/version or resubmit.

---

## 4. Workspace (analytics)

### Dashboard
Top-level overview: open POs, overdue, high-risk, and the headline numbers. Start here.

### Open PO Tracker
Every open (Approved) PO line, with EDD, delay, TNA stage and **internal status** (Overdue /
High Risk / On Track).
- **High Risk** = any critical-path TNA stage is **past its planned date with no actual date** —
  a live flag that clears the moment that stage is marked done.
- **Freeze columns:** **double-click any column header** to freeze everything up to it (they stay
  put while you scroll right); double-click it again to unfreeze.

### Vendor Performance / Merchant Performance
Per-vendor (and per-merchant) open load, delay %, capacity and **utilisation**.
- **Utilisation = Open Qty ÷ Monthly Capacity.** If it goes over 100% the cell shows
  **"100% · Over utilised"** (the real figure is in the hover tooltip) — the vendor is booked
  beyond capacity.

### Product Tracker / Product Matrix View / Urgent Replenishment
Product-level rollups and the urgent-replenishment shortlist.

---

## 5. Vendor Recommendation (rank vendors to buy from)

Ranks vendors by **completed-PO reliability + quality**, since 2025. Each rate has a hover
tooltip showing its coverage, so a rate built on little data reads as low-confidence.

| Column | Means |
|---|---|
| **Completion** | POs completed ÷ POs given. Do they finish what they're given? |
| **On-time** | Of completed POs, how many were **received (GRN) on/before the EDD**. Scored over the "rated" POs (those that have both an EDD and a GRN date). |
| **Delay** | The late share of those same rated POs. |
| **QC-fail** | Of the vendor's **customer-returned** items, the share that came back a **quality defect** (damaged/repair). |
| **Rejection** | Of goods **QC-checked at receipt (GRN)**, the share that **failed inbound QC** — the most direct quality signal. |
| **Confidence** | How much of the completed POs could actually be scored (High/Med/Low). |
| **Score** | `0.6×On-time + 0.4×Completion − 3×QC-fail% − 0.5×Rejection%`, out of 100. |

- **Sort** by any column (click the header) and set a **Min POs** filter. Vendors with fewer than
  5 POs are listed separately as **thin data** (not ranked).
- **Why some rates are "—" or 0:** the vendor has no returns/QC records attributed, or too few to
  score. A red rate means it's actually pulling the score down.
- **Note on Rejection:** inbound QC is done selectively (not every unit is inspected), so a high
  rejection % is a **flag to investigate**, not "X% of all goods are bad."

---

## 6. Workflows (the forms you fill)

### Buying Plan (`/buying-plan`) — Finished Goods + Fabric/Material
The monthly buying budget. Two tracks (FG and Fabric/Material), same layout.
- **View** = the running read-only plan (grouped Woven/Knitted, progress bars, Overdue-only filter).
  **Input** = the editable grid.
- Fill **Job / FOB / E-FOB** quantities (FG) or **Job Work / Purchase** (material). **Value is
  computed** from the **approved Standard Cost** — "no approved cost" means the rate isn't signed
  off yet. **Actual issued qty** comes from real POs placed that month.
- **Import a CSV** (product/material code + type + qty) or add codes manually. Black cells = you
  type; green cells = computed.
- Material Dyed lines have an editable **Colour**; add materials via the base-fabric → code picker.

### Replenishment (`/replenishment`) — read-only
Reorder quantities per colour for 30/60/90-day coverage (DOQ/ROP), from the inventory snapshot.
The 30-day figure feeds the Buying Plan's Pending Quantity.

### Standard Cost (`/standard-cost`) — a negotiation, then the reference cost
Cost is **negotiated, not just approved**: team **proposes** → admin sets a **target** → team
returns the **actual vendor rate** → admin **signs off** (FG: confirm fabric rate, then CM).
- The expandable **cost sheet** is a size-wise **CM matrix**: fabric rate is pulled from the
  **Fabric Cost** sheet (green), you paste/enter **CM** per size, **Total = fabric + CM**, and the
  **size-wise average** computes itself. **CAD/RFP** links and **Total PO avg** live here too.
- **Frozen** = once a PO is issued as the benchmark, the cost locks and can't be edited.
- Only signed-off (approved) rates value the Buying Plan.

### Fabric Cost (`/fabric-cost`)
Per-fabric costing. **Grey rate** can auto-fill (Yarn + Conversion); **Finished fabric cost**
(≈ grey + processing) is the value pulled into the Standard Cost CM matrix.

### Vendor Capacity (`/vendor-capacity`)
Only **Machines** and **Karigar** are typed per vendor — everything else computes. **Capacity/month
= Machines × Karigar**; **PO capacity = Capacity × type multiplier**; **Available = PO capacity −
In-process**. No approval; saving stamps "last updated".

### PO Approval (`/po-approval`) — raise → gate → approve → issue
- Pick **category** (FG / MAT / NPD — drives who approves) and **PO type**. Type the **vendor code**
  and the **name auto-fills**. **PO quantity is the sum of the size lines** (you don't type it) — add
  the colour/size lines. Fill the **Rate** (next to the cost sheet) — required to submit.
- **TNA gate:** the approver must **Review & confirm the TNA dates** before the cost can be approved,
  so an impossible delivery window can't be approved unchecked.
- **Requested total days** = first-delivery − submission date, locked at submit.
- After approval, **Issue** captures the EasyCom PO no. + first delivery; tick **"set as benchmark"**
  to freeze that product's standard cost. (DiGiO e-signing is Phase 2.)
- Below the form: the **SKU-wise submission/closure** table (row-wise Yes/No close).

### PO Details (Form) (`/po-details`) — read-only
Issuance metadata captured via a Google Form (signed docs, TNA link, colours), matched by PO ref.

### Inward Plan (`/inward-plan`) — read-only
Open Approved POs with stock still to arrive, soonest first.

### Receivable Plan (`/receivable-plan`) — weekly receiving input
Each row = one colour on an open PO, split by size (arriving on top, in-stock below).
- **Status** = live TNA risk (Overdue / High Risk / On Track); the ERP status shows beneath.
- **Sizes in stock** = how many arriving sizes are currently covered (the SKU-level read on OOS).
- Fill the only two editable fields — **Deliver this week** and **Qty this week**; **% of arriving**
  computes, and the page shows when the plan was last updated. Submit the week for approval.

### Cash Flow (`/cash-flow`)
Month-by-month payables forecast. **Vendor payment terms** are editable (default 45 days) and
editing them recomputes the whole forecast.

### Discontinue (`/discontinue`)
Two views: the **approval workflow** to stop a size / colour / whole product (always needs admin;
approving a colour or product drops it from the active lists), and the **ageing & liquidation**
view of discontinued stock still in the warehouse (ageing buckets, recommended discount/action).

### Approvals (`/approvals`)
The unified queue of everything awaiting your decision, with the per-PO **4-tab verify** detail
(Inventory · Standard Cost · TNA · Vendor) and the full approval log. The first decision wins.

---

## 7. Admin

- **Product / Fabric / Material Master** — the code lists the Buying Plan and costing read from.
  Adding/removing a code or marking it Discontinued flows straight through.
- **Users** — set roles (Admin / Team / Viewer) and active status.

---

## 8. Common doubts (FAQ)

**"No approved cost" on the Buying Plan?** The product's Standard Cost isn't signed off yet — approve
it in Standard Cost and the value fills in.

**A value shows "—" or 0?** The upstream data isn't there yet (e.g. no approved rate, no master value,
no matching PO/return). It's a data gap, not a bug — fill the source and it appears at the next refresh.

**"Undocumented — data gap" tag on a cost?** That product exists but has no cost sheet documented yet.

**Why can't I edit a plan/cost?** It's **Approved** (locked) — pick another month/version, or resubmit
if allowed. Approved standard costs also lock when a PO is issued as the benchmark ("Frozen").

**What's the difference between QC-fail and Rejection (Vendor Recommendation)?** QC-fail = *customer
returns* that came back defective (post-sale). Rejection = goods that failed *inbound QC at receipt*
(pre-stock) — the more direct vendor-quality signal.

**Why is a vendor "thin data" / not ranked?** Fewer than 5 POs given — too little to judge reliably.

**"Over utilised" on Vendor Performance?** Open quantity exceeds the vendor's monthly capacity; the cap
displays 100% and the true figure is in the tooltip.

**How do I freeze columns on the Open PO Tracker?** Double-click a column header (double-click again to
unfreeze).

**How current is what I'm seeing?** See §2 — most data syncs at 6 AM/6 PM; what you type is instant.

**Where's the exact formula for a number?** The **"What do these mean?"** button on that screen.
