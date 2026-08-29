# Standard Cost — full specification

Source: requirements dictated by Mahesh across sessions 1–2 (Aug 2026). This is the
canonical spec for the Standard Cost feature. It records **intent and worked
examples** so the team and future work share one source; it is not a status report.
Where the current code diverges, that is noted as a gap to close.

Related code: `src/app/standard-cost/`, `src/lib/forms/{cost,actions,queries,types}.ts`,
`supabase/migrations/*standard_cost*, *cost_*`.

---

## 0. The two-entity structure (foundational)

The Standard Cost of a product is **two linked standards concatenated**, not one
editable record:

1. **Finished Fabric Cost** — owned/maintained by **Vikram ji**.
2. **CMTP Cost** (Cutting / Manufacturing / Trims / Packaging) — owned by
   **Nimisha** and **Durgan / Durganshu**.

They are **separate ownership domains**. Both must be independently *standardized*
(approved/frozen) before the combined final cost is meaningful. The UI already
reflects this with sequential sign-off: **fabric rate confirmed first, then CM
second** (`fabric_confirmed_at` → `cm_confirmed_at`).

---

## 1. CMTP cost sheet — hierarchical template  *(building now)*

CMTP is **not a single number**. It is a hierarchical cost sheet built from
category heads. The **6 core mandatory heads** ("the 6 points in the core
architecture") — mandatory unless a sub-tab explicitly replaces one:

The live CMTP cost sheet is a flat list of operation lines that roll up to a
**FINAL CMTP** total. Mapped onto the mandatory heads (with the real line names):

| Head | Line items (from the live sheet) |
|---|---|
| **Labour** | *Karigar*, *Thekedar Comission* → subtotal "Absolute labour Cost" |
| **Cutting** | *Cutting* |
| **Finishing** | *Fabric QC*, *Iron*, *Thread Cutting*, *Final QC*, *Folding* |
| **Packaging** | *Packing - poly bag* |
| **Product Trims** ("other trims") | *Thread*, *Fusing*, *Button*, *Kaaj* — product-specific |
| **Brand Trims** | *Brand Trims* — company-specific (label, logo) |

**FINAL CMTP** = sum of every line across all heads.

Rules:
- **Product-specific caveats appear conditionally**, as *sub-tabs under the
  relevant head* — not as universal fields. Example: **buttoning cost** only
  applies to shirts → added as a sub-tab under Trims *only when relevant*.
- The team can **add sub-tabs/categories freely**. Existing masters are offered
  via dropdown; new ones are addable ad hoc.
- The **CMTP total = sum of all heads = the product's CM cost.**

### v1 implementation decisions (this pass)
- New table `sd_cmtp_component (product_code, category, label, amount, position)`.
  Each row is one line item under a head; a head can hold one plain amount or
  several labelled sub-items that roll up.
- The mandatory heads always render (blank = not yet costed). Each head's known
  operation lines (Karigar/Thekedar under Labour, Fabric QC/Iron/… under Finishing,
  etc. — see table above) are offered as one-click suggestion chips. Custom
  rows/heads are free-text and removable.
- **FINAL CMTP total owns `sd_standard_cost.cm_cost`** (documentation column; the
  Buying Plan values from job/fob/efob, never cm_cost — so this is safe).
- The existing per-size CM matrix stays as a legacy/override path; full unification
  (matrix CM defaulting from CMTP, per-size override) is **deferred**.
- A DB-backed **category master** ("existing masters via dropdown") is deferred;
  v1 uses the fixed head list + ad-hoc free labels.

---

## 2. SMV — Standard Minute Value  *(hard gate, later)*

Before CMTP cost is calculated, **garment grading** is assessed: number of stitch
points, garment construction, pattern parts. Based on stitch-part count, **time is
measured with a stopwatch, operation-level, during the first production run** — on
**every first PO**.

- **Compliance gap:** team only does this on ~6 of 10 first-POs. Not enforced.
- **Fix (system-enforced):** SMV entry is a **hard gate** — *until SMV is filled,
  you cannot invoice / move forward with the vendor.* The system enforces it, not a
  person catching the team afterward.

---

## 3. Product Trims Master  *(separate entity, later)*

- Replicates the Standard Cost UI/edit pattern.
- A similar master already exists informally (built by **Sourav Ghosh**) — reference/reuse
  its structure rather than starting fresh.
- Trims standardized against a **brand-quality list**, sourced/verified from the
  brand where possible — not ad hoc per-purchase.
- Its own separate entity **for now**, with a note to **link to NPD's trim master
  later**. There must be **exactly one master** — sync either direction, but never
  two independently maintained copies.
- **Immediate priority:** get raw data imported fast; perfect linking can wait. Team
  should start filling **5–10 entries** as onboarding practice to internalize cost
  awareness, even before full automation.

---

## 4. Fabric Cost Master  (Vikram ji's side)

Input → derived chain:

```
Grey rate (INPUT)
  → Landed rate (DERIVED: + checking cost, transportation, shrinkage value,
                 processing checking cost, packing charge)
  → + Profit margin (5%)
  → + Interest / debt-based addition
  → Final cost (DERIVED)
```

**Colour convention** (reconfirmed):
- **White / fixed** = standardized inputs.
- **Yellow** = variable input fields (grey rate, processing cost, days-waiting-derived final rate).
- **Green** = fully derived/computed, never manually touched.

Gaps:
- Fabric Master's structural fields (composition, warp/weft) exist, but **no cost
  data filled yet** — Vikram ji must populate.
- **Yarn-to-grey cost** is a distinct, currently-missing data source — Vikram's team
  must supply it.
- Discipline: fabric master is **updated every time** — a living, frequently-refreshed
  reference, not a one-time entry.

---

## 4b. Full garment cost buildup — the live sheet  *(reference)*

The complete standard cost sheet (per size: XS · S · M · L · XL · 2XL · 3XL · 4XL,
plus a **PO AVG** column) builds the FINAL PRICE like this:

```
Per size, two drivers sit at the top:
  STANDARD DOQ RATIO                 (size mix)
  56" W – AVG Fabric consumption (IN MTR)   e.g. XS 0.62 … 4XL 0.97, PO AVG 0.76

Fabric side (per metre → per garment):
  GREIGE RATE (L 100)   (INPUT, yellow)
  + DYEING COST
  + SHRINKAGE
  = DYED FABRIC COST (INR / Mtr)     (computed)
  → FABRIC COST         (= dyed fabric cost × fabric consumption for the size)

  + CMTP                (FINAL CMTP from §1)
  = TOTAL GARMENT COST

  + REJ    (5% or ₹10, whichever is LOWER)
  + OH     (5% or ₹10, whichever is LOWER)
  + MARGIN (15%)
  = TOTAL
  → FINAL PRICE
```

Notes:
- **Colour convention holds** (§4): greige rate is yellow (input); dyed fabric cost
  and everything downstream are green (computed).
- REJ and OH each cap at **₹10** (the lower of 5% or ₹10). MARGIN is a flat **15%**.
- FABRIC COST is size-dependent (consumption varies by size); CMTP is size-invariant.
- This buildup is not yet implemented — §1 (CMTP) is the first slice of it. FINAL PRICE
  automation (fabric buildup + REJ/OH/MARGIN) is a later piece.

---

## 5. Approval mechanism — Temporary vs Permanent  *(next, later)*

Core flow: select master from dropdown (or CSV) → standard cost auto-populates →
team indicates what's changing → submits for approval → **Remark mandatory on any
change request**.

**Batch, tabular, multi-product approval:**
- Select product → edit only the changed cost fields → save that product → next
  product → repeat → **submit the whole batch as one approval action** (not
  product-by-product).
- Every field in the request table shows, at minimum: **current value, proposed new
  value, computed total change** — approver sees the *delta at a glance*.

**The critical distinction:**

| | Temporary (PO-level) | Permanent (Master-level) |
|---|---|---|
| Cause | commodity-driven fluctuation (grey/cotton moving day to day) | structural change (dyeing genuinely up, chemical inflation) |
| Nature | expected, normal, tied to a specific PO's market moment | changes the benchmark going forward |
| System behaviour | **NOT a hard error** — logged/displayed as informational context ("grey +X% since last PO, remark optional") | **full approval + mandatory remark** |

### Validation rule (worked examples — exact)
- **Hard-block only on CM deviation.** Standard CM ₹90, PO submitted at ₹92 →
  **error**, requires explicit confirmation ("you're giving PO above standard cost,
  confirm you know why").
- **Commodity/fabric moves are NOT errors.** Grey moved ₹210 → ₹270 between the
  standard-cost reference and the PO → **not an error**; just displayed for
  awareness.
- Mechanism: a **pivoted table** tracks cost parameters (grey cost, finished fabric
  cost, CM cost, margin) **per PO row**; validate a new PO's commodity-linked fields
  against the **last issued PO's** values — the delta becomes visible context, not a
  block.

### v1 implementation decisions (this pass)
- Added the per-PO cost pivot to `sd_po_approval`: `grey_cost`,
  `finished_fabric_cost`, `cm_cost` (CMTP), `margin_pct` (+ `cm_override_note/_by/_at`,
  pre-provisioned for the later block). Captured on the PO raise form; the CMTP field
  pre-fills from the product's standard CMTP.
- The approval **cost tab** shows two groups: **CMTP** (PO vs standard, flagged when
  above) and **Commodity/fabric** (grey / finished-fabric / margin — informational).
  This makes Mahesh's distinction visible: CMTP is the parameter to watch, commodity
  moves are market noise.
- **Hard-block DEFERRED** (per Mahesh, added later): for now approval is *not* blocked
  when the PO's CMTP is above standard — the comparison is shown for review only.
  `decideApproval` keeps only the existing TNA gate. When enabled later, the block
  will require *Confirm above-standard CMTP* + a mandatory remark, logged as an
  approved exception (columns already provisioned).
- Backward-compatible: a PO with no CMTP captured, or a product with no standard CMTP,
  behaves exactly as before.
- **Deferred:** the batch multi-product **change-request** table (current/proposed/
  delta, temp-vs-permanent classification on the Standard Cost page); and the full
  **last-issued-PO delta** pivot (v1 compares against the standard, not the previous
  PO). The above-standard exception is the seed for §7.

---

## 6. EFOB Fabric Cost  *(third standard for FOB/EFOB, later)*

For FOB/EFOB POs specifically there is a **third standard: EFOB Fabric Cost** — a
**fixed rate the company sets monthly** for buying fabric / committing capital risk
on the vendor's behalf (in EFOB the company advances money and absorbs commodity-rate
risk instead of the vendor). This standard is **not in the base cost sheet today** and
must be added as **its own field**, separate from the main fabric-cost table.

---

## 7. PO-level hard gate vs an approval log  *(later)*

Once a Standard Cost change is **approved** (cost above the previous benchmark, gone
through remark + approval), the system **logs that specific approved exception**, and
**only then** allows that specific PO to issue at that cost.

- If a PO tries to issue at an above-standard cost that was **never separately
  approved → error, block issuance.**
- The system validates against an **approval log**, not just a static benchmark number.

---

## Build order (agreed)

1. **CMTP category breakdown** *(§1)* — foundational; SMV, trims master, and
   CM-deviation validation all build on this structure. ✅ done
2. Approval: temp vs permanent + CMTP-only hard-block *(§5)* — 🟡 per-PO cost pivot +
   CMTP-vs-standard review UI done; **hard-block deferred** (added later); batch
   change-request table + last-PO delta deferred.
3. SMV hard gate *(§2)*
4. PO hard gate vs approval log *(§7)*

Also outstanding: Product Trims Master *(§3)*, Fabric Cost Master population *(§4)*,
EFOB Fabric Cost field *(§6)*.
