'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, X } from 'lucide-react';

// Each field: plain meaning (detail), where the data comes from (source), and —
// where there is a calculation — the exact formula. Keyed by route.
type HelpItem = { field: string; source: string; formula?: string; detail: string };

const HELP: Record<string, HelpItem[]> = {
  '/buying-plan': [
    { field: 'Product code', source: 'Active products (sheet)', detail: 'The product you are planning to buy this month. Every active product is listed — set the ones you will not make to 0.' },
    { field: 'Product status / Woven · Knitted', source: 'Product master', detail: 'Read-only, pulled from the product master (sd_product_master) — never typed here. Shows “—” until the master is filled in.' },
    { field: 'Pending quantity', source: 'Replenishment (DOQ)', formula: '30-day ROP = Σ max(0, daily demand × 30 − stock − in-process)', detail: 'Computed from the Replenishment module (the DOQ-driven 30-day reorder), read-only. No longer typed by hand.' },
    { field: 'Job work / FOB / E-FOB quantity', source: 'You enter', detail: 'Split the planned pieces across the type of purchase order you expect to use.' },
    { field: 'Total quantity', source: 'Automatic', formula: 'Job work + FOB + E-FOB', detail: 'The three planned quantities added together.' },
    { field: 'Standard cost', source: 'Standard Cost sheet', detail: 'The approved job / FOB / E-FOB rates for the product, read-only. Shows “—” until a standard cost is approved.' },
    { field: 'Value to be bought', source: 'Automatic', formula: 'job_qty×job_cost + fob_qty×fob_cost + efob_qty×efob_cost', detail: 'Each PO-type quantity multiplied by its own approved standard cost. Shows “no approved cost” when the product has planned qty but no approved rate.' },
    { field: 'Actual issued quantity', source: 'Real PO data (GCP)', formula: 'Σ ordered quantity for POs placed this month', detail: 'The number of pieces actually ordered this month through the EasyCom PO pipeline.' },
    { field: 'Actual issued value', source: 'Real PO data (GCP)', formula: 'Σ (ordered quantity × price) for POs placed this month', detail: 'The total value of the pieces actually ordered this month.' },
    { field: 'Over plan (red row)', source: 'Automatic', formula: 'Actual issued qty > Total quantity', detail: 'A warning when you have ordered more than planned. Shown only — it never blocks saving or submitting.' },
    { field: 'Material line value (Fabric/Material track)', source: 'Automatic', formula: 'job_qty × Job rate + purchase_qty × Purchase rate', detail: 'On the Fabric/Material track, each line’s value from its Job Work and Purchase quantities at the approved material rates.' },
    { field: '% bought (View)', source: 'Automatic', formula: 'Σ actual issued qty ÷ Σ planned total qty × 100', detail: 'Whole-plan progress — issued vs planned pieces — shown on the View progress bars.' },
    { field: 'Overdue (View)', source: 'Automatic', formula: 'remaining > 0 and today > (plan-month start + 7 days)', detail: 'Buying still outstanding more than a week into the plan month. The Overdue-only filter narrows to these.' },
    { field: 'View / Input modes', source: 'Workflow', detail: 'View is the running read-only plan — grouped by Woven/Knitted, with a per-product progress bar (issued vs planned) and an Overdue-only filter for buying that is >1 week late. Input is the editable grid where you fill the month.' },
    { field: 'Save / Submit / Approve', source: 'Workflow', detail: 'Save keeps a draft; Submit sends it for review; Approval locks the plan. Large plans need admin approval, routine ones the team.' },
  ],
  '/vendor-capacity': [
    { field: 'The two inputs (LIVE)', source: 'You enter', detail: 'Only Machines allocated and Karigar allocated are ever typed. Everything else on the row is computed or a locked onboarding value.' },
    { field: 'Vendor type (FIXED)', source: 'Vendor master', detail: 'Job work / E-FOB / FOB / E-FOB-FOB — frozen at onboarding, read-only. It sets the multiplier.' },
    { field: 'Capacity / month', source: 'Automatic', formula: 'Machines × Karigar', detail: 'Auto-computed from the two live inputs — no longer typed (that blank field is what used to make PO capacity go negative).' },
    { field: 'PO capacity', source: 'Automatic', formula: 'Capacity/month × multiplier (Job ×1.0/30d · E-FOB ×1.5/45d · FOB ×2.5/75d · E-FOB-FOB ×2.0/60d)', detail: 'How much you can place on order for this vendor. Day-coverage = multiplier × 30 (E-FOB corrected to 45).' },
    { field: 'First machines (FIXED)', source: 'Vendor master', detail: 'Machines committed to SAADAA at onboarding — a one-time locked baseline pulled from the master CSV, same for new vendors.' },
    { field: 'In process', source: 'Real PO data (GCP)', formula: 'Σ pending qty on the vendor’s Approved POs', detail: 'Pieces already on order and not yet received, from the EasyCom pipeline.' },
    { field: 'Available', source: 'Automatic', formula: 'PO capacity − In process', detail: 'Free capacity for new POs. Negative (red) = over-committed.' },
    { field: 'Machine utilisation', source: 'Automatic', formula: 'Karigar ÷ Machines × 100', detail: 'Workers per machine — how densely the allocated machines are staffed.' },
    { field: 'Capacity utilisation', source: 'Automatic', formula: 'In process ÷ PO capacity × 100', detail: 'How full the vendor is against its PO capacity.' },
    { field: 'Last updated', source: 'You (on save)', detail: 'Auto-stamped whenever you change Machines or Karigar and hit Save. Over 7 days old shows as stale.' },
  ],
  '/po-approval': [
    { field: 'Category (FG / MAT / NPD)', source: 'You enter', detail: 'What the PO is for — this drives who approves it: NPD & Material are always 2-level (admin); FG follows the quantity threshold. FG checks TNA + vendor allocation, MAT checks quantity, NPD checks cost.' },
    { field: 'PO type (FOB / Job Work / E-FOB)', source: 'You enter', detail: 'How the PO is placed with the vendor. Descriptive — it does not change routing. E-FOB POs also need a CAD file folder link.' },
    { field: 'Product code / PO ref num', source: 'You enter', detail: 'What is being ordered and your PO reference (auto-numbering is phase 2).' },
    { field: 'Vendor code + name', source: 'You enter / vendor master', detail: 'Who the PO is with. Vendor code drives the live-capacity check on the approval card.' },
    { field: 'TNA sheet / Cost sheet link', source: 'You enter (Google Drive)', detail: 'Links to the TNA (time & action) plan and cost sheet for this PO.' },
    { field: 'PO quantity', source: 'Automatic', formula: 'Σ size-line quantities', detail: 'Total pieces on the PO — the sum of the colour/size lines, read-only (never typed). Drives the FG approval routing threshold (≤5000 team, >5000 admin).' },
    { field: 'Rate', source: 'You enter', detail: 'The negotiated per-piece rate, filled alongside the cost-sheet link. Required before a PO can be submitted.' },
    { field: 'PO closing date', source: 'You enter (as per TNA)', detail: 'When the PO should close, taken from the TNA plan.' },
    { field: 'Critical stage dates', source: 'You enter (proposed)', detail: 'PP sample due, GPT due, cutting start, inline QC due, and the critical-path first delivery date. These feed TNA / high-risk. On a submitted PO they are proposed until the approver confirms them.' },
    { field: 'Requested total days', source: 'Automatic (locked at submit)', formula: 'critical-path first delivery − submission date', detail: 'The requested lead time, computed and locked when the PO is submitted so it does not drift with the eventual approval date.' },
    { field: 'TNA gate (Review & confirm TNA)', source: 'Approver only', formula: 'Cost approval blocked until tna_confirmed = true', detail: 'Only this PO’s approver (Team for FG ≤5,000; Admin for >5,000 / MAT / NPD) can review and lock the TNA critical-path dates. Cost approval is hard-blocked until they confirm — so a nonsensical delivery window (e.g. 40 days for 2,000 pcs) can’t be cost-approved unchecked.' },
    { field: 'Trim card signed / Buying plan no.', source: 'You enter', detail: 'Whether the trim card is signed, and the buying plan number that links this PO back to the plan.' },
    { field: 'Vendor capacity on the card', source: 'Vendor capacity + Real PO data', formula: 'Live load = Σ pending qty on Approved POs · Capacity = last logged capacity/month', detail: 'The approver sees the vendor’s live in-process load and last-updated signed capacity before signing off.' },
    { field: 'Needs', source: 'Automatic', formula: 'FG ≤ 5,000 → Team (L1) · FG > 5,000 → Admin (L2) · MAT & NPD → Admin', detail: 'Which role must approve this PO.' },
    { field: 'Cycle time', source: 'Automatic', formula: 'submission → approval → vendor sign-off', detail: 'Rolling-average approval cycle at the top (submission→approval, approval→sign-off using the DiGiO signed date, and end-to-end), plus per-PO days. Distinct from TNA-stage production delays. Surfaced from sd_po_cycle_time.' },
    { field: 'Reporting screen', source: 'Automatic', detail: 'POs issued in the last 7 days, and approved POs still waiting to be issued this week.' },
    { field: 'Issue & sign (fields 19–25)', source: 'You enter at issuance', detail: 'On an approved PO, “Issue / sign” opens a panel: EasyCom PO no. (maps back to sd_po_master_raw), first actual delivery date, and the DiGiO signed docs (PO, cost sheet, TNA), signed ref number and date of sign. EasyCom no. is required to issue; signed docs can be added after.' },
    { field: 'Suggest PO ref / DiGiO', source: 'Automatic / Phase 2', formula: 'PO ref = FY / PO type / product / vendor', detail: 'Suggest builds the PO ref in the standard FY/type/product/vendor format (editable). The DiGiO fields are manual URLs for now — the DiGiO API integration will populate them automatically later.' },
    { field: 'Set as standard benchmark cost', source: 'You choose at issuance', detail: 'Tick this at issuance to lock the product’s standard cost as the fixed benchmark — it freezes and can’t drift or be overwritten by later PO costs. Never automatic; it’s an explicit choice.' },
  ],
  '/po-details': [
    { field: 'Where this comes from', source: 'Google Form → Sheet → auto-sync', detail: 'The “PO Details Form” responses land in a Google Sheet tab that syncs to the dashboard every ~5 minutes. No manual entry here — it is a read-only mirror.' },
    { field: 'What it holds', source: 'Form (issuance metadata)', detail: 'The sourcing metadata captured at PO issue time: signed PO / cost / TNA documents, the TNA sheet link, critical-stage dates (PP, GPT, cutting, inline), colours, buying-plan no.' },
    { field: 'Source of truth', source: 'GCP / EasyEcom', detail: 'The PO’s transactional data (qty, delivery, status) is owned by GCP/EasyEcom — this form only supplements it. Matched by PO ref.' },
    { field: 'In live pipeline', source: 'Automatic', formula: 'form PO ref = an open Approved PO in GCP', detail: '“live” means the PO is still an open Approved PO in the filtered GCP pipeline; otherwise it is a historically-issued PO now closed or excluded.' },
    { field: 'Signed docs', source: 'Form (Drive links)', detail: 'PO / Cost / TNA / CAD links open the Google Drive document when the cell is a URL; a filename-only value shows as plain text.' },
  ],
  '/inward-plan': [
    { field: 'PO / Product / Variant', source: 'Real PO data (GCP)', detail: 'Each row is one colour of one product on an open purchase order.' },
    { field: 'Ordered', source: 'Real PO data (GCP)', detail: 'How many pieces were ordered on that line.' },
    { field: 'Arriving', source: 'Real PO data (GCP)', formula: 'Σ pending qty (ordered − received)', detail: 'Pieces still to arrive — ordered but not yet received.' },
    { field: 'Expected', source: 'Real PO data (GCP)', detail: 'The soonest expected delivery date for that line.' },
    { field: 'What this shows', source: 'Open POs (Approved)', detail: 'Only Approved POs with stock still to come, soonest arrival first.' },
  ],
  '/cash-flow': [
    { field: 'Month due', source: 'Automatic', formula: 'commitment date + vendor payment terms', detail: 'Each buying commitment lands in the month its payment falls due.' },
    { field: 'Received (invoiced)', source: 'GRN (GCP)', formula: 'Σ GRN value where invoice date + terms falls in the month', detail: 'Goods already received and invoiced — a firm payable.' },
    { field: 'Projected (open PO)', source: 'Real PO data (GCP)', formula: 'Σ pending qty × price where delivery date + terms falls in the month', detail: 'Open POs not yet received — projected payable once they arrive.' },
    { field: 'Vendor payment terms', source: 'You set', detail: 'Days from invoice/receipt to payment, per vendor (default 45). Editing recomputes the whole forecast.' },
    { field: 'Past due', source: 'Automatic', formula: 'due date < today (invoiced, not settled)', detail: 'Invoiced obligations whose due date has already passed — assumed unpaid unless settled outside the system.' },
  ],
  '/fabric-cost': [
    { field: 'Fabric code', source: 'Fabric Master', detail: 'Rows seed from the active Fabric Master. The finished cost you set here is what the Standard Cost CM matrix pulls in.' },
    { field: 'Yarn / Conversion cost', source: 'You enter', detail: 'The yarn price and the yarn→grey conversion charge.' },
    { field: 'Grey rate', source: 'Automatic (suggested)', formula: 'Yarn cost + Conversion cost', detail: 'Click the calculator to set grey = yarn + conversion; still editable if the real grey differs.' },
    { field: 'Processing cost', source: 'You enter', detail: 'Dyeing / finishing charge to take grey fabric to finished fabric.' },
    { field: 'Finished fabric cost', source: 'You enter', formula: 'Grey rate + Processing cost', detail: 'The finished per-metre rate (conceptually grey + processing). This exact value is auto-pulled into the Standard Cost CM matrix as the Fabric rate.' },
  ],
  '/replenishment': [
    { field: 'Daily demand', source: 'Inventory planning (GCP)', formula: 'daily_quantity, else 45-day sales ÷ 45', detail: 'Average pieces sold per day for the colour, from the latest inventory-planning snapshot.' },
    { field: 'Stock / In process / DOQ', source: 'Inventory planning (GCP)', detail: 'Current stock, pieces already on order, and days-of-quantity coverage at the current sales rate.' },
    { field: '30 / 60 / 90-day reorder', source: 'Automatic', formula: 'max(0, daily demand × N − current stock − in-process)', detail: 'How much to reorder to cover N days. 30 is the immediate gap; 60/90 add forward coverage for long-lead vendors. Scales up with the window.' },
    { field: 'Feeds the Buying Plan', source: 'Automatic', detail: 'The 30-day reorder (summed per product) becomes the Buying Plan’s computed Pending Quantity — no longer typed by hand.' },
  ],
  '/receivable-plan': [
    { field: 'PO / Product / colour', source: 'Real PO data (GCP)', detail: 'Each row is one colour on an open (Approved) PO, split out by size. The PO number is the highlighted key column.' },
    { field: 'Arriving + size split (XS…5XL)', source: 'Real PO data (GCP)', formula: 'Σ pending qty per size', detail: 'Pieces still to arrive on this PO line, pivoted by size (top = arriving, muted = in stock).' },
    { field: 'Status (TNA risk)', source: 'Automatic', formula: 'Overdue if EDD passed · else High Risk if any critical-path TNA stage is past its planned date with no actual · else On Track', detail: 'Live TNA/risk status, recomputed each load from the merged tna_tracker + form actuals (same rule as the Open PO Tracker). The raw ERP status shows beneath.' },
    { field: 'DOQ / Stock / OOS', source: 'Inventory planning (GCP)', detail: 'Days-of-quantity, current stock and out-of-stock flag for the colour, from the latest inventory-planning snapshot.' },
    { field: 'Sizes in stock', source: 'Automatic', formula: 'sizes with stock ÷ sizes arriving on this line', detail: 'How many of the arriving sizes are currently covered by stock — the SKU-level read on the aggregate OOS count. Amber when not all sizes are covered.' },
    { field: 'Deliver this week / Qty this week', source: 'You enter', detail: 'The only two editable fields — when and how much you expect this week. Saved per row.' },
    { field: '% of arriving', source: 'Automatic', formula: 'Qty this week ÷ Arriving × 100', detail: 'What share of the arriving pieces your weekly qty covers, shown under the Qty field.' },
    { field: 'Last updated', source: 'Automatic', formula: 'latest weekly-input save across the plan', detail: 'When the weekly receiving plan was last touched — a per-row stamp and a page-level stamp.' },
  ],
  '/discontinue': [
    { field: 'Two views on this page', source: 'Workflow', detail: '“Discontinue requests” is the approval workflow to stop a size, colour or whole product code. “Discontinued Products View” is the ageing & liquidation view of stock still sitting in the warehouse for products already discontinued.' },
    { field: 'Scope (size / colour / product)', source: 'You choose', detail: 'Discontinue a specific size, a single colour (variant), or a whole product code. Colour and product drops remove it from the active list; size is finer-grained.' },
    { field: 'Reason & status', source: 'Workflow', detail: 'Give a short reason, then the request moves Draft → Submitted → Approved / Rejected. Discontinue always needs an admin; once a colour or product is approved it drops out of the active product list.' },
    { field: 'Available units / SKUs with stock', source: 'Discontinued-inventory sheet', detail: 'Top-line counts of discontinued stock still in the warehouse: total available pieces, how many distinct SKUs (colour + size) hold them, and how much of that is dead stock.' },
    { field: 'Ageing bucket', source: 'Automatic', formula: 'days in warehouse: New <90 · Aging 90–180 · Old 180–365 · Dead Stock >365', detail: 'How old the stock is, from “days in warehouse” on the sheet. A SKU is aged by its OLDEST available unit, so one very old piece pulls the whole SKU into the older bucket. Dead-stock rows are highlighted.' },
    { field: 'Oldest (days)', source: 'Discontinued-inventory sheet', formula: 'max(days in warehouse) across the SKU’s units', detail: 'The age of the oldest still-available unit in the SKU — this is what drives the ageing bucket and the recommended discount.' },
    { field: 'Recommended Discount', source: 'Automatic (ops rule)', formula: '<90d → none · 90–180 → 10% · 180–270 → 20% · 270–365 → 30% · >365 → 40–60%', detail: 'A suggested markdown based on the oldest unit’s age. The tiers step at 270 days, so the “Old” bucket splits into 20% and 30%.' },
    { field: 'Recommended action', source: 'Automatic (ops rule)', formula: 'no 45-day sales & >365d → Write-off review · qty>200 & >365d → Bulk liquidation / B2B · qty>50 → Run discount campaign · qty≥10 → Transfer to high-selling store · else → Sell through naturally', detail: 'The suggested next step per SKU, taken in priority order. “Write-off review” only fires when the variant has an explicit zero 45-day sales figure — unknown or unmapped sales are not treated as zero.' },
    { field: 'Value (cost) / Value (MRP)', source: 'Automatic', formula: 'available qty × cost, and available qty × MRP', detail: 'The money tied up in the remaining stock, at cost and at full retail — the size of the liquidation exposure.' },
    { field: 'Filters & CSV', source: 'Workflow', detail: 'Search or filter by category, colour, ageing bucket or recommended action; the action chips show the SKU count per action. “CSV” exports exactly the filtered rows.' },
    { field: 'Products Discontinued but Inventory Available (chart)', source: 'Automatic', formula: 'available units, grouped by category, stacked by ageing bucket', detail: 'A horizontal stacked bar of leftover units per product category, split into New / Aging / Old / Dead Stock and sorted so the biggest ageing liabilities sit at the top.' },
  ],
  '/approvals': [
    { field: 'Record', source: 'Submitted work', detail: 'The buying plan or discontinue request awaiting a decision. The sub-line shows its size or variant.' },
    { field: 'Submitted by / when', source: 'Automatic', detail: 'Who sent the item for approval and when.' },
    { field: 'Needs', source: 'Automatic', formula: 'Team — unless a buying plan over 5,000 pcs or any discontinue → Admin', detail: 'Which role is allowed to approve this item.' },
    { field: 'Approve / Reject', source: 'Your decision', detail: 'Only shows on items you may approve. The first decision wins — a second approver gets nothing to do.' },
    { field: 'Verify tab — Days of stock (PO)', source: 'Automatic', formula: 'current stock ÷ daily demand', detail: 'On a PO’s Inventory tab: how many days the current stock lasts at the current sales rate.' },
    { field: 'Verify tab — Cost variance (PO)', source: 'Automatic', formula: 'written rate − approved standard cost', detail: 'On the Standard Cost tab: how far the PO’s written rate sits above/below the approved standard (red when over).' },
    { field: 'Verify tab — Vendor headroom (PO)', source: 'Automatic', formula: 'capacity/month − in-process qty', detail: 'On the Vendor tab: free capacity for this PO (red when negative / over-committed).' },
    { field: 'Approved · First-Time vs Edited', source: 'Automatic', formula: 'Edited-and-Approved if the approver reworked it before approving, else First-Time Approved', detail: 'The approved badge distinguishes a clean first-time approval from one that needed edits/rework first.' },
    { field: 'Approval log', source: 'History', detail: 'Every status change, who made it, and any note — recorded automatically.' },
  ],
  '/standard-cost': [
    { field: 'Product / material code', source: 'Active products', detail: 'Seeded from the active list. Add a code here if a new product/material is not yet listed.' },
    { field: 'Job / FOB / E-FOB rate (Material: Job Work / Purchase)', source: 'You enter (negotiated)', detail: 'The final per-piece rate for each PO type, filled during negotiation. Job work excludes fabric (you supply it); FOB includes the fabric margin.' },
    { field: 'Proposed / Target', source: 'Negotiation', detail: 'Proposed = the team’s expected cost; Target = the cost Mahesh sets to negotiate toward. The actual vendor rate is entered against the target.' },
    { field: 'Negotiation stage', source: 'Automatic', formula: 'propose (team) → set target (admin) → submit rate (team) → sign off (admin)', detail: 'Where the cost sits in the negotiation. Sign-off flips the record to the approved Standard Cost; renegotiate / reject send it back.' },
    { field: 'Fabric rate (CM matrix)', source: 'Fabric Cost sheet', formula: 'finished fabric cost of the selected fabric code', detail: 'Auto-pulled (read-only, green) from the Fabric Cost sheet for the fabric code you pick — never typed here.' },
    { field: 'Total per size (CM matrix)', source: 'Automatic', formula: 'Fabric rate + CM', detail: 'The costed rate for one piece of that size: the pulled fabric rate plus the CM (cost of making) you enter for the size.' },
    { field: 'Size-wise average', source: 'Automatic', formula: 'Σ per-size Total ÷ number of costed sizes', detail: 'The average of the filled size totals — stored as the header CM cost.' },
    { field: 'Total PO average cost', source: 'You enter', detail: 'The blended PO average, entered directly on the detail sheet (not computed).' },
    { field: 'Status', source: 'Workflow', detail: 'Draft → Submitted → Approved / Rejected. Only signed-off (approved) rates are used by the Buying Plan. Standard cost always needs admin sign-off.' },
    { field: 'Frozen', source: 'Automatic', formula: 'set when a PO is issued with “set as benchmark” ticked', detail: 'Once frozen the standard cost is locked as the benchmark and can no longer be edited — never automatic, only on an explicit benchmark tick at PO issuance.' },
    { field: 'Where this is used', source: 'Buying Plan', formula: 'Buying Plan value = job×job_cost + fob×fob_cost + efob×efob_cost', detail: 'The Buying Plan values each PO-type quantity at its approved rate.' },
  ],
  '/product-master': [
    { field: 'Product code', source: 'Active products', detail: 'Seeded from the active product list. Add a code here if a new product is not yet listed.' },
    { field: 'Status', source: 'You set', detail: 'Active / Inactive / TBD / NPD / NPD-Not-Launched / Ongoing / Discontinued. This is what the Buying Plan shows (read-only there).' },
    { field: 'Woven / Knitted', source: 'You set', detail: 'The fabric type for the product. The Buying Plan reads this — it is no longer derived from the vendor.' },
    { field: 'Active', source: 'You set', detail: 'Turn off to mark a product inactive without deleting its master row.' },
    { field: 'Where this is used', source: 'Buying Plan', detail: 'The Buying Plan pulls Status and Woven/Knitted from here, read-only, so they are never typed on the plan itself.' },
    { field: 'Suggested NPD promotions', source: 'Automatic (inventory sales)', formula: 'NPD-Not-Launched product with any colour sold > 50 pcs (45 days)', detail: 'The FG-master auto-rule flags products that should move from NPD-Not-Launched to NPD. Review and apply with one click.' },
  ],
  '/fabric-master': [
    { field: 'Fabric code', source: 'You enter (manual)', detail: 'Entered by hand — never generated from the composition, since fabrics with the same nominal composition can differ by weave/GSM and need distinct codes.' },
    { field: 'Duplicate check', source: 'Automatic', formula: 'Existing code → blocked on save', detail: 'Before a new code is saved it is checked against the master; if it already exists the save is rejected. This is the value the master adds.' },
    { field: 'Composition fields', source: 'You enter (quality report)', detail: 'Composition, warp yarn count, weft yarn count, third thread / blend type, weave, GSM, and raw material / colour — from the fabric team’s quality-report format.' },
    { field: 'Active', source: 'You set', detail: 'Turn off to hide a fabric from the Buying Plan list without deleting its record.' },
    { field: 'Where this is used', source: 'Buying Plan (Material track)', detail: 'The Buying Plan fabric/material track picks its codes from this master. A Trims master will follow with the same manual-code + duplicate-check mechanism.' },
  ],
  '/users': [
    { field: 'Email', source: 'Login', detail: 'The person’s @saadaa.in login. Roles are matched to this email when they sign in.' },
    { field: 'Name', source: 'You enter', detail: 'The name shown inside the application.' },
    { field: 'Role', source: 'Access control', detail: 'Admin = full access and approves everything. Team = fills forms and approves routine items. Viewer = read-only.' },
    { field: 'Active', source: 'Access control', detail: 'Turn this off to make someone read-only without deleting them.' },
  ],
};

export function FormHelp({ route, title }: { route: string; title: string }) {
  const [open, setOpen] = useState(false);
  const items = HELP[route];
  if (!items) return null;
  return (
    <>
      <button type="button" className="help-button" onClick={() => setOpen(true)}>
        <CircleHelp size={17} /> What do these mean?
      </button>
      {open &&
        createPortal(
          <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
            <div
              className="modal modal-wide"
              role="dialog"
              aria-modal="true"
              aria-label={`${title} definitions`}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="modal-head">
                <h2>About {title}</h2>
                <button
                  className="icon-button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="help-intro">
                <span className="help-intro-icon">
                  <CircleHelp size={20} />
                </span>
                <div>
                  <strong>A quick guide to this workflow</strong>
                  <p>
                    Each field shows where its data comes from and, where there is
                    a calculation, the exact formula.
                  </p>
                </div>
              </div>
              <div className="definition-grid">
                {items.map((it, index) => (
                  <article className="definition-card" key={it.field}>
                    <span className="definition-number">{index + 1}</span>
                    <div>
                      <h3>{it.field}</h3>
                      <p>{it.detail}</p>
                      <div className="definition-meta">
                        <span className="definition-source">{it.source}</span>
                        {it.formula && (
                          <code className="definition-formula">= {it.formula}</code>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
