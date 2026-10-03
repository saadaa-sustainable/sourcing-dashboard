'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { CalendarCheck, ChevronDown, FileCheck, FileDown, FilePen, Layers, ListChecks, Send } from 'lucide-react';
import { issuePoApproval, previewPoSubmission, submitPoApproval } from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { awaitingEasycomDays } from '@/lib/business-logic';
import { reloadWithToast, toastError } from '@/lib/toast';
import { Field, Notice } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { PoReviewPanels } from '@/components/forms/po-review-panels';
import { SubmitChecksModal } from './submit-checks-modal';
import { PoDetailPanel } from './po-detail-panel';
import { PoLinesPanel } from './po-lines-panel';
import type { PoSubmissionChecks } from '@/lib/forms/queries-modules/po-checks';
import type { ApprovalQueueItem, PoApproval, PoApprovalLine, PoCycleTime, PoDeleteRequest, SdRole } from '@/lib/forms/types';

export const nfmt = (v: number) => v.toLocaleString('en-IN');
export const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
export const dateOnly = (ts: string | null | undefined) =>
  ts ? new Date(new Date(ts).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : null;
export const dayLabel = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
    : '—';
export const typeLabel = (po: PoApproval) =>
  po.po_type === 'job_work' ? 'Job Work' : po.po_type === 'efob' ? 'E-FOB' : po.po_type === 'FOB' ? 'FOB' : po.category.toUpperCase();

export const STAGE_LABELS = ['Drafted', 'Submitted', 'Approved', 'EasyCom', 'Delivering'];

/** Where the PO stands on the five-step strip: drafted → submitted → approved → EasyCom → delivering. */
export function poStage(po: PoApproval): { step: number; tone: 'done' | 'now' | 'bad' | 'wait' } {
  if (po.status === 'rejected') return { step: 2, tone: 'bad' };
  if (po.status === 'draft' || po.status === 'rework') return { step: 0, tone: po.status === 'rework' ? 'bad' : 'now' };
  if (po.status === 'submitted' || po.status === 'pending_l2') return { step: 2, tone: 'now' };
  if (po.status === 'approved' && !po.po_issued_at) return { step: 3, tone: 'wait' };
  return { step: 4, tone: 'now' };
}

export type PoFlag = { tone: 'ok' | 'warn' | 'bad' | 'wait' | 'none'; text: string; title?: string };

/** The one thing worth knowing about this PO, as a pill. */
export function poFlag(
  po: PoApproval,
  opts: { deleteRequest?: PoDeleteRequest; review?: ApprovalQueueItem; stdCm?: number; role: SdRole },
): PoFlag {
  const { deleteRequest, review, stdCm } = opts;
  if (deleteRequest && (deleteRequest.status === 'submitted' || deleteRequest.status === 'pending_l2')) {
    return { tone: 'bad', text: 'Deletion requested', title: `Reason: ${deleteRequest.reason} — raised by ${deleteRequest.requested_by}` };
  }
  if (po.status === 'rejected') return { tone: 'bad', text: 'Rejected', title: po.rejection_notes ?? undefined };
  if (po.status === 'rework') return { tone: 'warn', text: 'Sent back for rework', title: po.rework_notes ?? undefined };
  if (po.status === 'draft') {
    if (po.rate == null) return { tone: 'none', text: 'Draft · cost missing' };
    if (!po.po_qty) return { tone: 'none', text: 'Draft · no SKU lines yet' };
    return { tone: 'none', text: 'Draft · ready to submit' };
  }
  if (po.status === 'submitted' || po.status === 'pending_l2') {
    const flags: string[] = [];
    if (!po.tna_confirmed) flags.push('TNA dates not confirmed');
    const cap = review?.vendorPoCapacity ?? null;
    const inproc = review?.vendorInProcessQty ?? null;
    if (cap && cap > 0 && inproc != null && inproc + Number(po.po_qty || 0) > cap) flags.push('vendor over capacity');
    if (po.cm_cost != null && stdCm != null && po.cm_cost > stdCm + 0.005) flags.push('CMTP above standard');
    if (po.in_buying_plan === false) flags.push('not in plan');
    if (flags.length) return { tone: flags.length > 1 || flags[0] !== 'TNA dates not confirmed' ? 'bad' : 'warn', text: flags.join(' · ') };
    return { tone: 'ok', text: 'Ready to approve' };
  }
  if (po.status === 'approved' && !po.po_issued_at) {
    const d = awaitingEasycomDays(po);
    return { tone: d != null && d > 14 ? 'warn' : 'wait', text: d != null ? `${d} d waiting for an EasyCom PO` : 'Waiting for an EasyCom PO' };
  }
  if (po.first_actual_delivery_date && po.critical_path_first_delivery && po.first_actual_delivery_date > po.critical_path_first_delivery) {
    return { tone: 'warn', text: `Delivered late · ${dayLabel(po.first_actual_delivery_date)}` };
  }
  return { tone: 'ok', text: po.critical_path_first_delivery ? `On schedule · first delivery ${dayLabel(po.critical_path_first_delivery)}` : 'Issued' };
}

export type NextStep = { who: 'you' | 'other' | 'done'; title: string; detail: string };

/**
 * What happens next on this PO, and whether it is this person's move. Written from the
 * reader's side: "Add the SKU lines", not "status = draft".
 */
export function nextStep(po: PoApproval, role: SdRole, lines: PoApprovalLine[], deleteRequest?: PoDeleteRequest): NextStep {
  const canWork = canEdit(role, 'draft');
  if (deleteRequest && (deleteRequest.status === 'submitted' || deleteRequest.status === 'pending_l2')) {
    return canApprove(role, deleteRequest.status)
      ? { who: 'you', title: 'Decide the deletion request', detail: `${deleteRequest.requested_by} asked to delete this request: “${deleteRequest.reason}”. Approve or decline it in the Approvals queue; nothing else should move until then.` }
      : { who: 'other', title: 'Deletion request with the admin', detail: `Raised by ${deleteRequest.requested_by}: “${deleteRequest.reason}”. The request stays live until the admin decides.` };
  }
  switch (po.status) {
    case 'draft':
    case 'rework': {
      const fix = po.status === 'rework' ? `It was sent back${po.rework_notes ? `: “${po.rework_notes}”` : ''}. ` : '';
      if (!canWork) return { who: 'other', title: 'Being drafted by the sourcing team', detail: fix + 'It reaches the approver once the team submits it.' };
      if (po.rate == null) return { who: 'you', title: 'Add the cost', detail: fix + 'Open Edit, read the cost sheet in (or paste it), and save. The rate is required to submit.' };
      if (!lines.length || !Number(po.po_qty)) return { who: 'you', title: 'Add the SKU quantities', detail: fix + 'Open SKU lines and paste the team sheet or fill the size matrix. The PO quantity is the sum of the lines.' };
      return { who: 'you', title: 'Submit for approval', detail: fix + 'Everything needed is here. Submit runs the three checks (rate vs standard, vendor load, TNA against the vendor’s history) and routes it by value.' };
    }
    case 'submitted':
    case 'pending_l2': {
      const approver = po.status === 'pending_l2' ? 'the admin' : 'the approver';
      if (!canApprove(role, po.status)) return { who: 'other', title: `Awaiting ${approver}`, detail: `Submitted ${dayLabel(dateOnly(po.submitted_for_approval_at))}${po.submit_remark ? ` with the remark “${po.submit_remark}”` : ''}. Nothing to do here until they decide.` };
      if (!po.tna_confirmed) return { who: 'you', title: 'Confirm the TNA dates, then decide', detail: 'Check the critical-path dates in the TNA panel against the quantity and the vendor’s history, adjust if needed, and confirm. Approve unlocks after that; Rework and Reject are open now.' };
      return { who: 'you', title: 'Approve, rework or reject', detail: 'The four panels below are the review: stock, cost against standard, the confirmed TNA, and the vendor’s load with this PO. Decide under them; a reason is required to rework or reject.' };
    }
    case 'approved': {
      if (!po.po_issued_at) {
        const d = awaitingEasycomDays(po);
        return canWork
          ? { who: 'you', title: 'Create the PO in EasyCom and link it here', detail: `Approved ${dayLabel(dateOnly(po.approved_at))}${d != null ? `, ${d} day${d === 1 ? '' : 's'} ago` : ''}. The critical path cannot start until the PO exists in EasyCom. Enter its number below; the TNA dates are rebased on the issue date.` }
          : { who: 'other', title: 'Waiting to be created in EasyCom', detail: `Approved ${dayLabel(dateOnly(po.approved_at))}. The sourcing team links the EasyCom PO; the critical path starts from that date.` };
      }
      if (po.first_actual_delivery_date) return { who: 'done', title: 'Delivering', detail: `First delivery landed ${dayLabel(po.first_actual_delivery_date)}${po.critical_path_first_delivery ? ` against ${dayLabel(po.critical_path_first_delivery)} planned` : ''}. Receipts and closure are tracked under Submission & closure and PO Closure.` };
      return { who: 'done', title: 'In production', detail: `Issued in EasyCom ${dayLabel(dateOnly(po.po_issued_at))}${po.critical_path_first_delivery ? `; first delivery due ${dayLabel(po.critical_path_first_delivery)}` : ''}. Record the first actual delivery date under Signing details when it lands.` };
    }
    case 'rejected':
      return { who: 'done', title: 'Rejected', detail: `${po.rejection_notes ? `“${po.rejection_notes}”. ` : ''}A rejected request is closed; raise a new PO if the purchase is still needed.` };
    default:
      return { who: 'done', title: 'No action', detail: '' };
  }
}

/** The five-step stage strip. */
export function StageStrip({ po, large = false }: { po: PoApproval; large?: boolean }) {
  const stage = poStage(po);
  const labels = STAGE_LABELS.map((l, i) => (i === 2 && !(po.status === 'approved' || po.po_issued_at) ? 'Approval' : l));
  return (
    <span className={`poa-stages-wrap${large ? ' is-large' : ''}`}>
      <span className="poa-stages">
        {labels.map((l, i) => (
          <i key={l} className={i < stage.step ? 'done' : i === stage.step ? stage.tone : ''} />
        ))}
      </span>
      <span className="poa-stages-lbl">
        {labels.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </span>
    </span>
  );
}

type BodyProps = {
  po: PoApproval;
  cycle?: PoCycleTime;
  lines: PoApprovalLine[];
  role: SdRole;
  deleteRequest?: PoDeleteRequest;
  /** The queue's review item — the four panels + lines. */
  review?: ApprovalQueueItem;
  stdCm?: Record<string, number>;
  /** Edit opens the form in the list page's drawer: a callback there, a link from the PO's own page. */
  onEdit?: (po: PoApproval) => void;
  editHref?: string;
  editingId?: number | null;
  defaultLinesOpen?: boolean;
  defaultDetailOpen?: boolean;
  /** The PO's own page shows the review for every status; the card only while it is queued. */
  reviewAlways?: boolean;
};

/**
 * Everything that can be read or done on a PO: the review panels with the decision under
 * them, the EasyCom link, submit, SKU lines, the full record. The card body and the PO's
 * own page are this one component.
 */
export function PoCardBody({
  po,
  cycle,
  lines,
  role,
  deleteRequest,
  review,
  stdCm = {},
  onEdit,
  editHref,
  editingId = null,
  defaultLinesOpen = false,
  defaultDetailOpen = false,
  reviewAlways = false,
}: BodyProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [linesOpen, setLinesOpen] = useState(defaultLinesOpen);
  const [detailOpen, setDetailOpen] = useState(defaultDetailOpen);
  const [signingOpen, setSigningOpen] = useState(false);
  const [rowChecks, setRowChecks] = useState<PoSubmissionChecks | null>(null);

  const canIssue = canEdit(role, 'draft');
  const issued = Boolean(po.po_issued_at);
  const queued = po.status === 'submitted' || po.status === 'pending_l2';
  const isApprover = queued && canApprove(role, po.status);
  const linesEditable = (po.status === 'draft' || po.status === 'rework') && canIssue;
  const editableHere = linesEditable && canEdit(role, po.status);
  const isEditing = editingId === po.id;
  const stdCmForPo = po.product_code ? stdCm[po.product_code.trim()] : undefined;
  const aboveStdCm = po.cm_cost != null && stdCmForPo != null && po.cm_cost > stdCmForPo + 0.005;
  const exceptionLogged = Boolean(po.cm_override_at);
  const needsCostOverride = aboveStdCm && !exceptionLogged && !issued;
  const [costOverrideNote, setCostOverrideNote] = useState('');
  const [benchmark, setBenchmark] = useState(false);
  const [iss, setIss] = useState({
    easycom_po_no: po.easycom_po_no ?? '',
    po_ref_num: po.po_ref_num ?? '',
    first_actual_delivery_date: po.first_actual_delivery_date ?? '',
    signed_po_document_url: po.signed_po_document_url ?? '',
    signed_cost_sheet_url: po.signed_cost_sheet_url ?? '',
    signed_tna_url: po.signed_tna_url ?? '',
    signed_po_ref_number: po.signed_po_ref_number ?? '',
    date_of_po_sign: po.date_of_po_sign ?? '',
    trim_card_signed: po.trim_card_signed ? 'true' : 'false',
  });
  const setI = (k: keyof typeof iss, v: string) => setIss((s) => ({ ...s, [k]: v }));
  const qty = Number(po.po_qty || 0);
  const raisedOn = dateOnly(po.timestamp_created ?? po.created_at);

  function submit() {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    start(async () => {
      const pv = await previewPoSubmission(p);
      if (!pv.ok) return setError(toastError(pv.error));
      setRowChecks(pv.checks);
    });
  }
  function confirmRowSubmit(remark: string) {
    setError(null);
    const p = new FormData();
    p.set('id', String(po.id));
    p.set('submit_remark', remark);
    start(async () => {
      const res = await submitPoApproval(p);
      if (res.ok) {
        setRowChecks(null);
        reloadWithToast(res.message ?? 'Saved.');
      } else setError(toastError(res.error));
    });
  }
  function saveIssuance() {
    setError(null);
    if (needsCostOverride && !costOverrideNote.trim()) {
      setError('This PO is above the standard CMTP — confirm with a reason to issue.');
      return;
    }
    const p = new FormData();
    p.set('id', String(po.id));
    Object.entries(iss).forEach(([k, v]) => p.set(k, v));
    p.set('set_benchmark', benchmark ? 'true' : 'false');
    if (needsCostOverride) {
      p.set('cost_override', 'true');
      p.set('cost_override_note', costOverrideNote);
    }
    start(async () => {
      const res = await issuePoApproval(p);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setError(toastError(res.error));
    });
  }

  const showIssuance = po.status === 'approved' && canIssue && (!issued || signingOpen);
  const showReview = Boolean(review?.poDetail) && (queued || reviewAlways);

  return (
    <div className="poa-body">
      {rowChecks && (
        <SubmitChecksModal checks={rowChecks} pending={pending} onConfirm={confirmRowSubmit} onCancel={() => setRowChecks(null)} />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {po.status === 'rework' && po.rework_notes && (
        <Notice tone="warn"><strong>Sent back for rework:</strong> {po.rework_notes}</Notice>
      )}
      {po.status === 'rejected' && po.rejection_notes && (
        <Notice tone="error"><strong>Rejected:</strong> {po.rejection_notes}</Notice>
      )}
      {deleteRequest && (deleteRequest.status === 'submitted' || deleteRequest.status === 'pending_l2') && (
        <Notice tone="warn">
          <strong>Deletion requested</strong> by {deleteRequest.requested_by} — “{deleteRequest.reason}”.
          {canApprove(role, deleteRequest.status) ? <> Decide it in <a href="/approvals">Approvals →</a>.</> : ' It is waiting with the admin.'}
        </Notice>
      )}

      {/* ---- The review: the four panels, from the same item the Approvals queue reads. */}
      {showReview && review && <PoReviewPanels item={review} role={role} />}
      {queued && !review?.poDetail && (
        <p className="wf-subtle">Awaiting approval{po.submit_remark ? ` — remark: ${po.submit_remark}` : ''}.</p>
      )}
      {queued && review?.submitNote && <p className="poa-note">{review.submitNote}</p>}

      {/* ---- The decision, right under the review. */}
      {isApprover && (
        <div className="poa-decide">
          {!po.tna_confirmed && <p className="wf-subtle">Approve unlocks once the TNA dates are confirmed above. Rework and Reject are open.</p>}
          <ApprovalBar
            entityType="po_approval"
            entityId={String(po.id)}
            entityLabel={`PO request ${po.request_id}`}
            onDone={(r) => { if (r.ok) reloadWithToast(r.message ?? 'Saved.'); }}
          />
        </div>
      )}
      {queued && !isApprover && (
        <p className="wf-subtle">Awaiting {po.status === 'pending_l2' ? 'the admin' : 'the approver'} — submitted {dayLabel(dateOnly(po.submitted_for_approval_at))}.</p>
      )}

      {/* ---- Approved: link the EasyCom PO (the critical path starts there). */}
      {showIssuance && (
        <div className="poa-issue">
          <div className="poa-issue-head">
            <strong>{issued ? 'Signing details' : 'Link the EasyCom PO'}</strong>
            <span className="wf-subtle">
              {issued
                ? `Issued ${dayLabel(dateOnly(po.po_issued_at))}`
                : 'Approved — nothing starts until the PO exists in EasyCom. Enter its number to link it; the TNA dates are rebased on the issue date.'}
            </span>
          </div>
          <div className="wf-form-grid">
            <Field label="EasyCom PO no." hint={`links the real PO to ${po.request_id}`}>
              <input value={iss.easycom_po_no} placeholder="EasyCom PO #" onChange={(e) => setI('easycom_po_no', e.target.value)} />
            </Field>
            <Field label="EasyCom PO reference" hint="as EasyCom shows it — optional">
              <input value={iss.po_ref_num} placeholder="e.g. FY26-27/FOB/SDRPT/REG-01" onChange={(e) => setI('po_ref_num', e.target.value)} />
            </Field>
            <Field label="First actual delivery date" hint="EasyCom">
              <input type="date" value={iss.first_actual_delivery_date} onChange={(e) => setI('first_actual_delivery_date', e.target.value)} />
            </Field>
          </div>
          <label className="wf-check-field">
            <input type="checkbox" checked={iss.trim_card_signed === 'true'} onChange={(e) => setI('trim_card_signed', e.target.checked ? 'true' : 'false')} />
            <span>Trim card signed — captured at issuance</span>
          </label>
          <label className="wf-check-field wf-benchmark">
            <input type="checkbox" checked={benchmark} onChange={(e) => setBenchmark(e.target.checked)} />
            <span>Set as <strong>standard benchmark cost</strong> — freezes this product’s standard cost as the fixed reference.</span>
          </label>
          {needsCostOverride && (
            <div className="wf-cost-gate">
              <p className="wf-inline-error">
                CMTP ₹{nfmt(Number(po.cm_cost))} is above the standard ₹{nfmt(Math.round(Number(stdCmForPo) * 100) / 100)}. Confirm the above-standard cost with a reason — it is logged as an approved exception.
              </p>
              <input className="wf-mini-input" placeholder="Reason for issuing above standard" value={costOverrideNote} onChange={(e) => setCostOverrideNote(e.target.value)} />
            </div>
          )}
          {exceptionLogged && (
            <p className="wf-subtle">Above-standard cost approved{po.cm_override_by ? ` by ${po.cm_override_by}` : ''}{po.cm_override_note ? ` — ${po.cm_override_note}` : ''}.</p>
          )}
          <div className="wf-footer-actions">
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={saveIssuance}
              disabled={pending || (!issued && !iss.easycom_po_no.trim()) || (needsCostOverride && !costOverrideNote.trim())}
            >
              <FileCheck size={14} /> {issued ? 'Save signing details' : 'Link EasyCom PO'}
            </button>
            {issued && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setSigningOpen(false)}>Close</button>
            )}
          </div>
        </div>
      )}

      {/* ---- Everything else that can be done from here. */}
      <div className="poa-actions">
        {editableHere && editHref && (
          <Link className="wf-btn wf-btn-ghost wf-btn-sm" href={editHref} title="Open this request in the form">
            <FilePen size={14} /> Edit
          </Link>
        )}
        {editableHere && !editHref && (
          <button type="button" className={`wf-btn wf-btn-sm ${isEditing ? 'wf-btn-primary' : 'wf-btn-ghost'}`} onClick={() => onEdit?.(po)} title="Open this request in the form">
            <FilePen size={14} /> {isEditing ? 'Editing' : 'Edit'}
          </button>
        )}
        {canSubmit(role, po.status) && (
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={submit} disabled={pending || !qty} title={qty ? 'Run the three checks and submit' : 'Add SKU lines first'}>
            <Send size={14} /> Submit for approval
          </button>
        )}
        <button type="button" className={`wf-btn wf-btn-sm ${linesOpen ? 'wf-btn-primary' : 'wf-btn-ghost'}`} onClick={() => setLinesOpen((v) => !v)}>
          <Layers size={14} /> SKU lines ({lines.length})
        </button>
        <button type="button" className={`wf-btn wf-btn-sm ${detailOpen ? 'wf-btn-primary' : 'wf-btn-ghost'}`} onClick={() => setDetailOpen((v) => !v)}>
          <ListChecks size={14} /> Full record
        </button>
        {po.status === 'approved' && issued && canIssue && !signingOpen && (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setSigningOpen(true)}>
            <CalendarCheck size={14} /> Signing details
          </button>
        )}
        {po.status === 'approved' && (
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`/api/po/${po.id}/pdf`} title={`Download ${po.request_id} as a PDF`}>
            <FileDown size={14} /> PDF
          </a>
        )}
        <span className="poa-datelog">
          Raised {dayLabel(raisedOn)}
          {po.submitted_for_approval_at ? ` · submitted ${dayLabel(dateOnly(po.submitted_for_approval_at))}` : ''}
          {po.approved_at ? ` · approved ${dayLabel(dateOnly(po.approved_at))}${cycle?.days_to_approve != null ? ` (${cycle.days_to_approve} d)` : ''}` : ''}
          {po.po_issued_at ? ` · EasyCom ${dayLabel(dateOnly(po.po_issued_at))}${cycle?.days_to_issue != null ? ` (${cycle.days_to_issue} d)` : ''}` : ''}
        </span>
      </div>

      {linesOpen && (
        <PoLinesPanel
          poId={po.id}
          poRef={po.po_ref_num ?? po.request_id}
          productCode={po.product_code}
          lines={lines}
          editable={linesEditable}
          onSaved={() => reloadWithToast()}
          onClose={() => setLinesOpen(false)}
        />
      )}
      {detailOpen && <PoDetailPanel po={po} lines={lines} cycle={cycle} />}
    </div>
  );
}

/**
 * One purchase order as a card in the list. The head is a link to the PO's own page; the
 * chevron opens the same review and actions in place.
 */
export function PoCard({
  po,
  cycle,
  lines,
  role,
  deleteRequest,
  review,
  stdCm = {},
  onEdit,
  editingId = null,
  defaultOpen = false,
}: {
  po: PoApproval;
  cycle?: PoCycleTime;
  lines: PoApprovalLine[];
  role: SdRole;
  deleteRequest?: PoDeleteRequest;
  review?: ApprovalQueueItem;
  stdCm?: Record<string, number>;
  onEdit?: (po: PoApproval) => void;
  editingId?: number | null;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const stdCmForPo = po.product_code ? stdCm[po.product_code.trim()] : undefined;
  const flag = poFlag(po, { deleteRequest, review, stdCm: stdCmForPo, role });
  const qty = Number(po.po_qty || 0);
  const value = po.rate != null ? qty * Number(po.rate) : null;
  const vendorLabel = po.vendor_name || po.vendor_code || '—';
  const queued = po.status === 'submitted' || po.status === 'pending_l2';
  const issued = Boolean(po.po_issued_at);
  const raisedOn = dateOnly(po.timestamp_created ?? po.created_at);
  const subline = [
    typeLabel(po),
    po.status === 'approved' || issued
      ? `approved ${dayLabel(dateOnly(po.approved_at))}`
      : queued
        ? `submitted ${dayLabel(dateOnly(po.submitted_for_approval_at))}`
        : `${po.status === 'rework' ? 'rework' : po.status === 'rejected' ? 'rejected' : 'draft'}, ${dayLabel(raisedOn)}`,
    po.easycom_po_no ? `EasyCom ${po.easycom_po_no}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const step = nextStep(po, role, lines, deleteRequest);

  return (
    <article className={`poa-card${open ? ' is-open' : ''}${editingId === po.id ? ' is-editing' : ''}`}>
      <div className="poa-row">
        <Link href={`/po-approval/${po.id}`} className="poa-row-link" title={`Open ${po.request_id} — ${step.title}`}>
          <span className={`poa-dot is-${flag.tone}`} />
          <span className="poa-id">
            {po.request_id}
            <small>{subline}</small>
          </span>
          <span className="poa-who">
            <b>
              {po.product_code ?? '—'}
              <span className={`wf-cat-chip wf-cat-${po.category}`}>{po.category.toUpperCase()}</span>
            </b>
            <span>
              {vendorLabel}
              {po.in_buying_plan === false ? ` · ad-hoc${po.ad_hoc_reason ? `, ${po.ad_hoc_reason}` : ''}` : po.in_buying_plan === true ? ' · in plan' : ''}
            </span>
          </span>
          <span className="poa-qty">
            <b>{qty ? `${nfmt(qty)} pcs` : 'no lines'}</b>
            <span>{value != null ? `${inr(value)} · ₹${nfmt(Number(po.rate))}/pc` : po.rate != null ? `₹${nfmt(Number(po.rate))}/pc` : 'rate missing'}</span>
          </span>
          <span className="poa-flagcol">
            <span className={`poa-flag is-${flag.tone}`} title={flag.title}>{flag.text}</span>
            <small className={`poa-next is-${step.who}`}>{step.who === 'you' ? 'Next, you: ' : step.who === 'other' ? 'Next: ' : ''}{step.title}</small>
          </span>
          <StageStrip po={po} />
        </Link>
        <button
          type="button"
          className="poa-chev"
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Open the review and actions here'}
          title={open ? 'Collapse' : 'Review and act here'}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown size={15} />
        </button>
      </div>
      {open && (
        <PoCardBody
          po={po}
          cycle={cycle}
          lines={lines}
          role={role}
          deleteRequest={deleteRequest}
          review={review}
          stdCm={stdCm}
          onEdit={onEdit}
          editingId={editingId}
        />
      )}
    </article>
  );
}
