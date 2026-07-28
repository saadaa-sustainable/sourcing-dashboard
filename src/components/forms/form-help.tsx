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
    { field: 'Product status / Woven · Knitted', source: 'You enter', detail: 'Typed in, descriptive only. Not used in any calculation yet.' },
    { field: 'Pending quantity', source: 'Reference', detail: 'A demand estimate shown for context. Not part of the totals yet.' },
    { field: 'Job work / FOB / E-FOB quantity', source: 'You enter', detail: 'Split the planned pieces across the type of purchase order you expect to use.' },
    { field: 'Total quantity', source: 'Automatic', formula: 'Job work + FOB + E-FOB', detail: 'The three planned quantities added together.' },
    { field: 'Standard value', source: 'You enter', detail: 'The expected cost of one piece.' },
    { field: 'Value to be bought', source: 'Automatic', formula: 'Total quantity × Standard value', detail: 'This product’s slice of the month’s buying budget. The column total is the whole budget being approved.' },
    { field: 'Actual issued qty / value', source: 'Real PO data (GCP)', formula: 'qty = Σ ordered qty · value = Σ (ordered qty × price), for POs placed this month', detail: 'What has actually been ordered this month, from the EasyCom PO pipeline in BigQuery. Compared against your plan.' },
    { field: 'Over plan (red row)', source: 'Automatic', formula: 'Actual issued qty > Total quantity', detail: 'A warning when you have ordered more than planned. Shown only — it never blocks saving or submitting.' },
    { field: 'Save / Submit / Approve', source: 'Workflow', detail: 'Save keeps a draft; Submit sends it for review; Approval locks the plan. Large plans need admin approval, routine ones the team.' },
  ],
  '/vendor-capacity': [
    { field: 'Vendor · Type', source: 'Vendor master (sheet)', detail: 'The vendor and its type (Job work / E-FOB / FOB). The type sets the multiplier used below.' },
    { field: 'Machines allotted / Active karigar', source: 'You enter', detail: 'Machines and workers assigned to SAADAA this week.' },
    { field: 'Capacity / month', source: 'You enter', detail: 'Pieces the vendor says they can make in a month. The base figure for PO capacity.' },
    { field: 'Machines at onboarding / Capacity signed', source: 'You enter', detail: 'What was committed at onboarding — reference, and the base for machine utilisation.' },
    { field: 'PO capacity', source: 'Automatic', formula: 'Capacity/month × multiplier (Job ×1.0, E-FOB ×1.5, FOB ×2.5)', detail: 'How much you can place on order with this vendor.' },
    { field: 'In process', source: 'Real PO data (GCP)', formula: 'Σ pending qty on the vendor’s Approved POs', detail: 'Pieces already on order and not yet received — from the EasyCom PO pipeline in BigQuery.' },
    { field: 'Available', source: 'Automatic', formula: 'PO capacity − In process', detail: 'Free capacity for new POs. A negative value means the vendor is over-committed.' },
    { field: 'Utilisation', source: 'Automatic', formula: 'In process ÷ PO capacity × 100', detail: 'How full the vendor is.' },
    { field: 'Last updated', source: 'Weekly log', detail: 'When this week’s row was submitted. Capacity is a weekly log; last week pre-fills the form.' },
  ],
  '/po-approval': [
    { field: 'PO ref', source: 'You enter', detail: 'Your reference for this purchase order. Auto-numbered POs come in phase 2 — for now type your own.' },
    { field: 'Type (FG / Material / NPD)', source: 'You enter', detail: 'FG = finished goods, Material = fabric/trims, NPD = new product development. NPD always needs admin approval.' },
    { field: 'Product code / Vendor code', source: 'Active products & vendors', detail: 'What is being ordered and who from. Vendor code drives the live-capacity check on the approval card.' },
    { field: 'Quantity', source: 'You enter', detail: 'Total pieces on the PO. Drives the approval routing threshold.' },
    { field: 'Number of colours', source: 'Automatic', formula: 'Distinct variants known for the product code (PO data)', detail: 'How many colours the product has, counted from the PO pipeline. Filled in when you save.' },
    { field: 'Cost sheet / TNA link', source: 'You enter', detail: 'Links to the cost sheet and the TNA (time & action) plan for this PO.' },
    { field: 'TNA critical dates', source: 'You enter', detail: 'The four production milestones — PP sample, GPT, cutting, inline — plus the closing date.' },
    { field: 'Vendor load (live)', source: 'Real PO data (GCP)', formula: 'Σ pending qty on the vendor’s Approved POs', detail: 'Shown on the approval card so the approver sees how loaded the vendor already is before signing off.' },
    { field: 'Needs', source: 'Automatic', formula: 'FG/Material ≤ 5,000 → Team · > 5,000 → Admin · NPD → Admin', detail: 'Which role must approve this PO.' },
    { field: 'Cycle time', source: 'Automatic', formula: 'Days between submit → approve → issue', detail: 'How long each stage of the PO lifecycle took, from the timestamps captured along the way.' },
    { field: 'Issue (EasyCom PO number)', source: 'You enter at issuance', detail: 'After approval, enter the EasyCom PO number. It ties this approval back to the real PO in the pipeline.' },
    { field: 'DGO signing / auto PO number', source: 'Phase 2', detail: 'Stubbed for now — digital sign-off and automatic PO numbering arrive in a later phase.' },
  ],
  '/inward-plan': [
    { field: 'PO / Product / Variant', source: 'Real PO data (GCP)', detail: 'Each row is one colour of one product on an open purchase order.' },
    { field: 'Ordered', source: 'Real PO data (GCP)', detail: 'How many pieces were ordered on that line.' },
    { field: 'Arriving', source: 'Real PO data (GCP)', formula: 'Σ pending qty (ordered − received)', detail: 'Pieces still to arrive — ordered but not yet received.' },
    { field: 'Expected', source: 'Real PO data (GCP)', detail: 'The soonest expected delivery date for that line.' },
    { field: 'What this shows', source: 'Open POs (Approved)', detail: 'Only Approved POs with stock still to come, soonest arrival first.' },
  ],
  '/discontinue': [
    { field: 'Product · Variant', source: 'Active variants (sheet)', detail: 'The exact colour/variant that should be stopped.' },
    { field: 'Reason', source: 'You enter', detail: 'Briefly explain why the variant should be discontinued.' },
    { field: 'Status', source: 'Workflow', detail: 'Draft → Submitted → Approved / Rejected. Once Approved, the variant drops out of the Buying Plan’s product list.' },
    { field: 'Requested by / Decision', source: 'Workflow', detail: 'Who raised the request, and the approve/reject action. Discontinue always needs an admin.' },
  ],
  '/approvals': [
    { field: 'Record', source: 'Submitted work', detail: 'The buying plan or discontinue request awaiting a decision. The sub-line shows its size or variant.' },
    { field: 'Submitted by / when', source: 'Automatic', detail: 'Who sent the item for approval and when.' },
    { field: 'Needs', source: 'Automatic', formula: 'Team — unless a buying plan over 5,000 pcs or any discontinue → Admin', detail: 'Which role is allowed to approve this item.' },
    { field: 'Approve / Reject', source: 'Your decision', detail: 'Only shows on items you may approve. The first decision wins — a second approver gets nothing to do.' },
    { field: 'Approval log', source: 'History', detail: 'Every status change, who made it, and any note — recorded automatically.' },
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
