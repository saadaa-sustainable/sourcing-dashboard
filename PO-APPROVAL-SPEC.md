# PO Approval — cycle-time / closure-date logic

Source: requirements dictated by Mahesh (Aug 2026, `Prompts.docx`). Canonical spec
for how PO delivery timing is planned, validated, and flagged. Records intent + the
live incident that motivated it; not a status report.

Related code: `src/app/po-approval/`, `src/lib/forms/actions.ts` (`confirmTna`,
`issuePoApproval`, `decideApproval`), `sd_po_approval`.

---

## The incident (why this exists)

Observed live: the team **extended a PO's closure date by 13 days** (approval-implied
closure ~Oct 21 → actual TNA-driven closure Nov 3) **without it being caught or
flagged** as unusual. This spec is the response.

## There is no fixed PO cycle time

There is **no single standard approval→closure number** to validate against. PO
closure timing is properly **derived from TNA stage durations**, which themselves
depend on the vendor's **real production capacity / machine-line availability** — not
a flat rule.

The stated ideal (not necessarily built): closure timing comes from a real
**PPC — Production Planning & Control** conversation between **Quality**,
**Sourcing / Supply Chain**, and the **Vendor**, where the vendor commits specific
cut / production dates against their real machine-line allocation — not a rough
estimate.

## Two planning layers (kept distinct)

| Layer | When | Scope |
|---|---|---|
| **Capacity Planning** | pre-PO, vendor-level | what capacity the vendor has, how much can be allocated across pending/upcoming orders — production slotting with the supplier |
| **TNA Planning** | post-PO-issuance | the stage-by-stage critical path for POs that have actually been issued |

## The rule

Once a PO is **approved**: **quantity / allocation may change** (re-negotiating how
much of an approved PO goes to which vendor line is fine), **but the timeline should
not**. Extending the delivery timeline after approval is not expected behaviour and
**should be flagged if it happens**.

Decision (confirmed): **soft-flag + log**, not a hard block — the change is allowed
but surfaced + audited. A hard block was explicitly *not* wanted (it would obstruct
legitimate PPC re-planning).

---

## v1 implementation (this pass)

In-app, an approved PO's **planned** timeline is already **locked**: `savePoApproval`
refuses non-draft/rework edits, and `confirmTna` (the "Re-confirm TNA" path) is only
exposed while `submitted` / `pending_l2` — i.e. pre-approval. So the "extended after
approval" case surfaces as the **actual** delivery landing past the **approved** date.

- **Soft-flag at issuance** (`issuePoApproval`): when `first_actual_delivery_date` is
  later than the approved `critical_path_first_delivery`, it computes the slip in days,
  **writes an approval-log entry** (`PO … · timeline extended Nd`), and returns a
  **⚠ warning** in the result toast. It **never blocks** issuance.
- **Badge** on the PO Approval row: `⚠ timeline +Nd` (tooltip shows approved vs actual
  dates) whenever the actual first delivery is past the approved one.
- No migration — both dates (`critical_path_first_delivery`, `first_actual_delivery_date`)
  already exist on `sd_po_approval`.

### Deferred / open
- **Actual closure vs approved closure** from the **TNA tracker** (the incident was about
  the *closure* date, driven by production-stage durations in the `tna_tracker` mirror
  table). v1 uses the in-app first-delivery pair; a fuller cross-table comparison of
  TNA-derived closure vs the approved window is a follow-up.
- **PPC capacity-planning session** as a first-class pre-PO step (vendor commits dated
  line allocation) is not modelled yet — it currently lives in Vendor Capacity.
- Threshold: v1 flags **any** positive slip (> 0 days). A grace threshold (e.g. flag
  only > N days) can be added if the flag proves noisy.
