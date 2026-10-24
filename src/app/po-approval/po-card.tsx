'use client';

import { canEditPoSection, scopedPoRework, poReworkLabel, awaitingTnaReworkSave } from '@/lib/po-rework';
import { useId, useState, useTransition } from 'react';
import Link from 'next/link';
import { CalendarCheck, ChevronDown, FileCheck, FileDown, FilePen, Layers, ListChecks, Send } from 'lucide-react';
import { issuePoApproval, previewPoSubmission, submitPoApproval } from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { awaitingEasycomDays } from '@/lib/business-logic';
import { reloadWithToast, toastError } from '@/lib/toast';
import { Field, Notice } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { PoReviewPanels, PoVendorCapacity } from '@/components/forms/po-review-panels';
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

export const STAGE_LABELS = ['Drafted', 'Submitted', 'Approved', 'EasyEcom', 'Delivering'];

/** Where the PO stands on the five-step strip: drafted → submitted → approved → EasyEcom → delivering. */
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
  if (po.status === 'rejected') return { tone: 'bad', text: 'Rejected / Discarded', title: po.rejection_notes ?? undefined };
  if (po.status === 'rework') return { tone: 'warn', text: 'Rework / Reassign', title: po.rework_notes ?? undefined };
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
    return { tone: d != null && d > 14 ? 'warn' : 'wait', text: d != null ? `${d} d waiting for an EasyEcom PO` : 'Waiting for an EasyEcom PO' };
  }
  if (po.first_actual_delivery_date && po.critical_path_first_delivery && po.first_actual_delivery_date > po.critical_path_first_delivery) {
    return { tone: 'warn', text: `Delivered late · ${dayLabel(po.first_actual_delivery_date)}` };
  }
  return { tone: 'ok', text: po.critical_path_first_delivery ? `On schedule · first delivery ${dayLabel(po.critical_path_first_delivery)}` : 'Issued' };
}

export type NextStepFocus = 'cost' | 'lines' | 'submit' | 'tna' | 'decide' | 'easycom' | null;
export type NextStep = { who: 'you' | 'other' | 'done'; title: string; detail: string; focus: NextStepFocus };

/**
 * What happens next on this PO, and whether it is this person's move. Written from the
 * reader's side: "Add the SKU lines", not "status = draft".
 */
export function nextStep(po: PoApproval, role: SdRole, lines: PoApprovalLine[], deleteRequest?: PoDeleteRequest): NextStep {
  const canWork = canEdit(role, 'draft');
  if (deleteRequest && (deleteRequest.status === 'submitted' || deleteRequest.status === 'pending_l2')) {
    return canApprove(role, deleteRequest.status)
      ? { who: 'you', title: 'Decide the deletion request', detail: `${deleteRequest.requested_by} asked to delete this request: “${deleteRequest.reason}”. Approve or decline it in the Approvals queue; nothing else should move until then.`, focus: null }
      : { who: 'other', title: 'Deletion request with the admin', detail: `Raised by ${deleteRequest.requested_by}: “${deleteRequest.reason}”. The request stays live until the admin decides.`, focus: null };
  }
  switch (po.status) {
    case 'draft':
    case 'rework': {
      const fix = po.status === 'rework' ? `It was sent back${po.rework_notes ? `: “${po.rework_notes}”` : ''}. ` : '';
      if (!canWork) return { who: 'other', title: 'Being drafted by the sourcing team', detail: fix + 'It reaches the approver once the team submits it.', focus: null };
      if (po.rate == null) return { who: 'you', title: 'Add the cost', detail: fix + 'Open Edit, read the cost sheet in (or paste it), and save. The rate is required to submit.', focus: 'cost' };
      if (!lines.length || !Number(po.po_qty)) return { who: 'you', title: 'Add the SKU quantities', detail: fix + 'Paste the team sheet or fill the size matrix in the SKU quantities box below. The PO quantity is the sum of the lines.', focus: 'lines' };
      return { who: 'you', title: 'Submit for approval', detail: fix + 'Everything needed is here. Submit runs the three checks (rate vs standard, vendor load, TNA against the vendor’s history) and routes it by value.', focus: 'submit' };
    }
    case 'submitted':
    case 'pending_l2': {
      const approver = po.status === 'pending_l2' ? 'the admin' : 'the approver';
      if (!canApprove(role, po.status)) return { who: 'other', title: `Awaiting ${approver}`, detail: `Submitted ${dayLabel(dateOnly(po.submitted_for_approval_at))}${po.submit_remark && /[A-Za-z0-9]/.test(po.submit_remark) ? ` with the remark “${po.submit_remark}”` : ''}. Nothing to do here until they decide.`, focus: null };
      if (!po.tna_confirmed) return { who: 'you', title: 'Confirm the TNA dates, then decide', detail: 'Check the critical-path dates in the TNA panel against the quantity and the vendor’s history, adjust if needed, and confirm. Approve unlocks after that; Rework / Reassign and Reject / Discard are open now.', focus: 'tna' };
      return { who: 'you', title: 'Review the PO request for your approval', detail: 'Review Cost, TNA and SKU quantities to proceed ahead with the approval, rework and rejection.', focus: 'decide' };
    }
    case 'approved': {
      if (!po.po_issued_at) {
        const d = awaitingEasycomDays(po);
        return canWork
          ? { who: 'you', title: 'Create the PO in EasyEcom and link it here', detail: `Approved ${dayLabel(dateOnly(po.approved_at))}${d != null ? `, ${d} day${d === 1 ? '' : 's'} ago` : ''}. The critical path cannot start until the PO exists in EasyEcom. Enter its number below; the TNA dates are rebased on the issue date.`, focus: 'easycom' }
          : { who: 'other', title: 'Waiting to be created in EasyEcom', detail: `Approved ${dayLabel(dateOnly(po.approved_at))}. The sourcing team links the EasyEcom PO; the critical path starts from that date.`, focus: null };
      }
      if (po.first_actual_delivery_date) return { who: 'done', title: 'Delivering', detail: `First delivery landed ${dayLabel(po.first_actual_delivery_date)}${po.critical_path_first_delivery ? ` against ${dayLabel(po.critical_path_first_delivery)} planned` : ''}. Receipts and closure are tracked under Submission & closure and PO Closure.`, focus: null };
      return { who: 'done', title: 'In production', detail: `Issued in EasyEcom ${dayLabel(dateOnly(po.po_issued_at))}${po.critical_path_first_delivery ? `; first delivery due ${dayLabel(po.critical_path_first_delivery)}` : ''}. Record the first actual delivery date under Signing details when it lands.`, focus: null };
    }
    case 'rejected':
      return { who: 'done', title: 'Rejected / Discarded', detail: `${po.rejection_notes ? `“${po.rejection_notes}”. ` : ''}A rejected request is closed; raise a new PO if the purchase is still needed.`, focus: null };
    default:
      return { who: 'done', title: 'No action', detail: '', focus: null };
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
 * them, the EasyEcom link, submit, SKU lines, the full record. The card body and the PO's
 * own page are this one component.
 */
export function PoCardBody({
  po,
  cycle,
  lines,
  role,
  editHref,
  deleteRequest,
  review,
  stdCm = {},
  defaultDetailOpen = false,
  reviewAlways = false,
}: BodyProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The next step's control is opened and spotlit, so "add the SKU quantities" is not a
  // small button among six — it is the box with the accent border and the label on it.
  const step = nextStep(po, role, lines, deleteRequest);
  const focus = step.who === 'you' ? step.focus : null;
  const [recordTab, setRecordTab] = useState<'sku' | 'edit' | 'detail'>(defaultDetailOpen ? 'detail' : 'sku');
  const recordTabId = useId();
  const linesOpen = recordTab !== 'detail';
  const editingSku = recordTab === 'edit';
  const detailOpen = recordTab === 'detail';
  function selectRecordTab(tab: 'sku' | 'edit' | 'detail') {
    if (tab === recordTab) return;
    if (editingSku && !window.confirm('Discard unsaved quantity changes? Use Save to keep them.')) return;
    setRecordTab(tab);
  }
  const [signingOpen, setSigningOpen] = useState(false);
  const [rowChecks, setRowChecks] = useState<PoSubmissionChecks | null>(null);

  const canIssue = canEdit(role, 'draft');
  const issued = Boolean(po.po_issued_at);
  const queued = po.status === 'submitted' || po.status === 'pending_l2';
  const isApprover = queued && canApprove(role, po.status);
  // House rule: until approved, everything is amendable (draft, pending, rework, rejected).
  const editableHere = po.status !== 'approved' && canIssue && canEdit(role, po.status);
  const reworkSections = scopedPoRework(po);
  const needsTnaSave = awaitingTnaReworkSave(po);
  const headerRework = reworkSections?.filter((section) => section === 'cost' || section === 'tna' && needsTnaSave) ?? [];
  const stdCmForPo = po.product_code ? stdCm[po.product_code.trim()] : undefined;
  const aboveStdCm = po.cm_cost != null && stdCmForPo != null && po.cm_cost > stdCmForPo + 0.005;
  const exceptionLogged = Boolean(po.cm_override_at);
  const needsCostOverride = aboveStdCm && !exceptionLogged && !issued;
  const [costOverrideNote, setCostOverrideNote] = useState('');
  const [benchmark, setBenchmark] = useState(false);
  const [issuanceError, setIssuanceError] = useState<string | null>(null);
  const [issuanceMessage, setIssuanceMessage] = useState<string | null>(null);
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
    setIssuanceError(null);
    setIssuanceMessage(null);
    if (needsCostOverride && !costOverrideNote.trim()) {
      setIssuanceError(toastError('This PO is above the standard CMTP — confirm with a reason to issue.'));
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
      try {
        const res = await issuePoApproval(p);
        if (!res.ok) {
          setIssuanceError(toastError(res.error));
          return;
        }
        const message = issued ? 'Signing details saved.' : `EasyEcom PO ${iss.easycom_po_no.trim()} linked successfully.`;
        setIssuanceMessage(res.message || message);
        reloadWithToast(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not link the EasyEcom PO. Please try again.';
        setIssuanceError(toastError(message));
      }
    });
  }

  const showIssuance = po.status === 'approved' && canIssue && (!issued || signingOpen);
  const showReview = Boolean(review?.poDetail) && (queued || reviewAlways);

  return (
    <div className={`poa-body${focus ? ` is-focus-${focus}` : ''}`}>
      {rowChecks && (
        <SubmitChecksModal checks={rowChecks} pending={pending} onConfirm={confirmRowSubmit} onCancel={() => setRowChecks(null)} />
      )}
      {error && <Notice tone="error">{error}</Notice>}
      {po.status === 'rework' && po.rework_notes && (
        <Notice tone="warn"><strong>Rework / Reassign:</strong> {po.rework_notes}</Notice>
      )}
      {po.status === 'rejected' && po.rejection_notes && (
        <Notice tone="error"><strong>Rejected / Discarded:</strong> {po.rejection_notes}</Notice>
      )}
      {deleteRequest && (deleteRequest.status === 'submitted' || deleteRequest.status === 'pending_l2') && (
        <Notice tone="warn">
          <strong>Deletion requested</strong> by {deleteRequest.requested_by} — “{deleteRequest.reason}”.
          {canApprove(role, deleteRequest.status) ? <> Decide it in <a href="/approvals">Approvals →</a>.</> : ' It is waiting with the admin.'}
        </Notice>
      )}

      {queued && review?.submitNote && <p className="poa-note">{review.submitNote}</p>}

      {/* ---- The review: the four panels, from the same item the Approvals queue reads. */}
      {showReview && review && <PoReviewPanels hideVendor item={review} role={role} spotlightTna={focus === 'tna'} />}
      {queued && !review?.poDetail && (
        <p className="wf-subtle">Approval Pending{po.submit_remark ? ` — remark: ${po.submit_remark}` : ''}.</p>
      )}

      {editableHere && headerRework.length > 0 && (
        <Notice tone="warn">
          <p>Rework required: <strong>{poReworkLabel(reworkSections)}</strong>. Edit the selected sections, save your changes, then submit again. Other sections remain read-only.</p>
          <Link className="wf-btn wf-btn-ghost wf-btn-sm" href={editHref ?? `/po-approval?edit=${po.id}`}>
            <FilePen size={14} /> Edit {poReworkLabel(headerRework)}
          </Link>
        </Notice>
      )}

      {/* ---- Everything else that can be done from here. */}
      <div className="poa-actions">
        <div className="poa-record-tabs" role="tablist" aria-label="PO request views"
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const index = tabs.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
              : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            tabs[next].focus(); tabs[next].click();
          }}>
          <button type="button" role="tab" id={`${recordTabId}-sku-tab`} aria-controls={`${recordTabId}-sku-panel`}
            aria-selected={recordTab === 'sku'} tabIndex={recordTab === 'sku' ? 0 : -1} onClick={() => selectRecordTab('sku')}>
            <Layers size={14} /> SKU lines ({lines.length})
          </button>
          {editableHere && canEditPoSection(po, 'sku') && (
            <button type="button" role="tab" id={`${recordTabId}-edit-tab`} aria-controls={`${recordTabId}-edit-panel`}
              aria-selected={editingSku} tabIndex={editingSku ? 0 : -1} onClick={() => selectRecordTab('edit')}>
              <FilePen size={14} /> Edit PO Quantity
            </button>
          )}
          <button type="button" role="tab" id={`${recordTabId}-detail-tab`} aria-controls={`${recordTabId}-detail-panel`}
            aria-selected={detailOpen} tabIndex={detailOpen ? 0 : -1} onClick={() => selectRecordTab('detail')}>
            <ListChecks size={14} /> View PO Request Detail
          </button>
        </div>
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
          {po.po_issued_at ? ` · EasyEcom ${dayLabel(dateOnly(po.po_issued_at))}${cycle?.days_to_issue != null ? ` (${cycle.days_to_issue} d)` : ''}` : ''}
        </span>
      </div>

      {linesOpen && (
        <div role="tabpanel" id={`${recordTabId}-${recordTab}-panel`} aria-labelledby={`${recordTabId}-${recordTab}-tab`} tabIndex={0}>
          {focus === 'lines' && (
            <div className="poa-focus-label">
              Your next step · add the SKU quantities — paste the team’s sheet or fill the size matrix, save, then Submit for approval
            </div>
          )}
          <PoLinesPanel
            key={editingSku ? 'editing' : 'viewing'}
            inlineEdit
            poId={po.id}
            poRef={po.po_ref_num ?? po.request_id}
            productCode={po.product_code}
            lines={lines.filter((line) => Number(line.qty) > 0)}
            editable={editingSku && editableHere && canEditPoSection(po, 'sku')}
            onSaved={() => { setRecordTab('sku'); reloadWithToast(); }}
            onClose={() => selectRecordTab('sku')}
          />
        </div>
      )}
      {showReview && review && <PoVendorCapacity item={review} highlighted />}
      {/* ---- Approved: link the EasyEcom PO (the critical path starts there). */}
      {issuanceMessage && <div role="status"><Notice tone="ok">{issuanceMessage}</Notice></div>}
      {showIssuance && (
        <div className="poa-issue" id={focus === 'easycom' ? 'poa-focus' : undefined}>
          {focus === 'easycom' && <div className="poa-issue-title">Enter EasyEcom PO Detail</div>}
          <div className="poa-issue-head">
            <strong>{issued ? 'Signing details' : 'Link the EasyEcom PO'}</strong>
            <span className="wf-subtle">
              {issued
                ? `Issued ${dayLabel(dateOnly(po.po_issued_at))}`
                : 'Approved — nothing starts until the PO exists in EasyEcom. Enter its number to link it; the TNA dates are rebased on the issue date.'}
            </span>
          </div>
          <div className="wf-form-grid">
            <Field label="EasyEcom PO no." hint={`links the real PO to ${po.request_id}`}>
              <input value={iss.easycom_po_no} placeholder="EasyEcom PO #" onChange={(e) => setI('easycom_po_no', e.target.value)} />
            </Field>
            <Field label="EasyEcom PO reference" hint="as EasyEcom shows it — optional">
              <input value={iss.po_ref_num} placeholder="e.g. FY26-27/FOB/SDRPT/REG-01" onChange={(e) => setI('po_ref_num', e.target.value)} />
            </Field>
            <Field label="First actual delivery date" hint="EasyEcom">
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
          {issuanceError && <div role="alert"><Notice tone="error">{issuanceError}</Notice></div>}
          <div className="wf-footer-actions">
            <button
              type="button"
              className="wf-btn wf-btn-primary poa-link-button"
              onClick={saveIssuance}
              disabled={pending || (!issued && !iss.easycom_po_no.trim()) || (needsCostOverride && !costOverrideNote.trim())}
            >
              <FileCheck size={14} /> {pending ? (issued ? 'Saving signing details...' : 'Linking EasyEcom PO...') : issued ? 'Save signing details' : 'Link EasyEcom PO'}
            </button>
            {issued && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setSigningOpen(false)}>Close</button>
            )}
          </div>
        </div>
      )}

      <div className="poa-submit-row">
      {canSubmit(role, po.status) && !needsTnaSave && (
        <button type="button" className="wf-btn wf-btn-primary poa-submit-button" onClick={submit} disabled={pending || editingSku || !qty} title={qty ? 'Run the three checks and submit' : 'Add SKU lines first'}>
          <Send size={14} /> {po.status === 'rework' || po.status === 'rejected' ? 'Re-Submit for Approval' : 'Submit for approval'}
        </button>
      )}
      </div>
      {detailOpen && <div role="tabpanel" id={`${recordTabId}-detail-panel`} aria-labelledby={`${recordTabId}-detail-tab`} tabIndex={0}><PoDetailPanel po={po} lines={lines} cycle={cycle} /></div>}

      {/* ---- The decision follows the review, SKU quantities and record controls. */}
      {isApprover && editingSku && <p className="wf-subtle">Save or cancel SKU changes before making an approval decision.</p>}
      {isApprover && !editingSku && (
        <div className="poa-decide" id={focus === 'decide' ? 'poa-focus' : undefined}>
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
    po.easycom_po_no ? `EasyEcom ${po.easycom_po_no}` : null,
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
