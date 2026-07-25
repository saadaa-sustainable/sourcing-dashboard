'use client';

import { useState } from 'react';
import { CircleHelp, X } from 'lucide-react';

type HelpItem = { field: string; source: string; detail: string };

// For each form: what the field means, where its data comes from, and how it
// feeds a calculation. Keyed by route so FormLayout can look it up from `active`.
const HELP: Record<string, HelpItem[]> = {
  '/buying-plan': [
    { field: 'Product code', source: 'Active products', detail: 'Read from the live PO data (pending_po_master), with any approved-discontinued variants removed. Every active product is listed so you allocate it or set it to zero.' },
    { field: 'Product status / Woven · Knitted', source: 'Manual', detail: 'Typed in for now — there is no product master feeding fabric or status yet. Descriptive only; not used in any calculation.' },
    { field: 'Pending quantity', source: 'Manual (stub)', detail: 'A reference demand figure. The replenishment module that will feed it does not exist yet, so it is entered by hand and shown for context only.' },
    { field: 'Job work qty / FOB qty / E-FOB qty', source: 'Input', detail: 'How much of the product to buy through each PO type. These three are added together to give Total quantity.' },
    { field: 'Total quantity', source: 'Calculated', detail: 'Job work + FOB + E-FOB. It is multiplied by Standard value to produce Value to be bought.' },
    { field: 'Standard value', source: 'Input', detail: 'The per-piece standard cost. Used as the multiplier for Value to be bought.' },
    { field: 'Value to be bought', source: 'Calculated', detail: 'Total quantity × Standard value. This is the month’s buying budget for that product; the column total is the whole budget being approved.' },
    { field: 'Actual issued qty / value', source: 'PO data', detail: 'Taken from POs dated in this plan month (pending_po_master): qty = sum of ordered quantity, value = qty × item price. A stand-in for the EasyCom feed. It is compared against the plan.' },
    { field: 'Over plan (red row)', source: 'Calculated', detail: 'Shown when Actual issued qty is greater than the planned Total quantity. A warning only — it never blocks saving or submitting.' },
    { field: 'Month · Save / Submit / Approve', source: 'Workflow', detail: 'The month this budget covers. A plan stays editable until it is approved; large plans need admin approval, routine ones can be approved by the team.' },
  ],
  '/vendor-capacity': [
    { field: 'Vendor · Type', source: 'Vendor masters', detail: 'The vendor and its type (Job work / E-FOB / FOB) from the vendor master data. The type sets the capacity multiplier used below.' },
    { field: 'Machines allotted / Active karigar', source: 'Input', detail: 'Machines and workers assigned to SAADAA this week. Machines allotted is the numerator of machine utilisation.' },
    { field: 'Capacity / month', source: 'Input', detail: 'The vendor’s stated monthly piece capacity. It is the base figure for PO capacity.' },
    { field: 'Machines at onboarding / Capacity signed', source: 'Input', detail: 'What was committed when the vendor was onboarded. Machines at onboarding is the denominator for machine utilisation; Capacity signed is reference.' },
    { field: 'PO capacity', source: 'Calculated', detail: 'Capacity / month × the type multiplier (Job work ×1.0, E-FOB ×1.5, FOB ×2.5). How much you can place on order with this vendor.' },
    { field: 'In process', source: 'Open PO data', detail: 'Quantity already on open POs with this vendor, from pending_po_master. Subtracted from PO capacity to get Available.' },
    { field: 'Available', source: 'Calculated', detail: 'PO capacity − In process. Free capacity for new POs; a negative number means the vendor is over-committed.' },
    { field: 'Utilisation', source: 'Calculated', detail: 'In process ÷ PO capacity × 100 — how full the vendor is.' },
    { field: 'Last updated', source: 'sd_vendor_capacity_log', detail: 'When this week’s row was submitted. Capacity is an append-only weekly log; the previous week pre-fills the form.' },
  ],
  '/discontinue': [
    { field: 'Product code · Variant', source: 'Active variants', detail: 'Chosen from the live active product/variant list (pending_po_master). Identifies exactly which colour/variant to stop making.' },
    { field: 'Reason', source: 'Input', detail: 'Why the variant is being discontinued. Free text for the approver.' },
    { field: 'Status', source: 'sd_discontinue_request', detail: 'Draft → Submitted → Approved / Rejected. Once Approved, that variant is removed from the Buying Plan’s active product list — this is how the two forms link.' },
    { field: 'Requested by · Decision', source: 'Workflow', detail: 'Who raised the request, and the approve/reject action. Discontinue always needs an admin decision.' },
  ],
  '/approvals': [
    { field: 'Record', source: 'sd_buying_plan / sd_discontinue_request', detail: 'The item waiting on a decision — a monthly buying plan or a discontinue request. The sub-line shows its size (product codes / pieces) or the variant.' },
    { field: 'Submitted by / Submitted', source: 'The record', detail: 'Who submitted it and when.' },
    { field: 'Needs', source: 'Calculated routing', detail: 'Which role must approve: routine items can be signed off by the team; larger buying plans and all discontinues escalate to an admin.' },
    { field: 'Approve / Reject', source: 'Workflow', detail: 'Your decision. It only appears on items you are allowed to approve, and updating is atomic — a second approver on the same item gets nothing to do.' },
    { field: 'Approval log (When / Record / Change / Actor / Notes)', source: 'sd_approval_log', detail: 'The audit trail: every status change, who made it, and any note. Written automatically on each decision.' },
  ],
  '/users': [
    { field: 'Email', source: 'sd_user', detail: 'The person’s @saadaa.in login. Roles are matched to this email when they sign in.' },
    { field: 'Name', source: 'sd_user', detail: 'Display name — cosmetic.' },
    { field: 'Role', source: 'sd_user', detail: 'Admin = full access and approves everything. Team = fills forms and approves routine items. Viewer = read-only. This is what every permission check across the app reads.' },
    { field: 'Active', source: 'sd_user', detail: 'Turning a user inactive drops them to read-only without deleting them. Anyone not listed here is read-only by default.' },
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
      {open && (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <div
            className="modal modal-wide"
            role="dialog"
            aria-modal="true"
            aria-label={`${title} definitions`}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>{title} — what do these mean?</h2>
              <button
                className="icon-button"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            <ul className="wf-help-list">
              {items.map((it) => (
                <li key={it.field}>
                  <div className="wf-help-head">
                    <strong>{it.field}</strong>
                    <span className="wf-help-source">{it.source}</span>
                  </div>
                  <p>{it.detail}</p>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
