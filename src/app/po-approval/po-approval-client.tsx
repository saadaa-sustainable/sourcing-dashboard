'use client';

import { Fragment, useEffect, useMemo, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import { CalendarCheck, CheckCircle, ChevronDown, ChevronRight, FileSpreadsheet, Plus, Save, Search, Send, Trash2, X } from 'lucide-react';
import {
  checkPlanMembership,
  deletePoApproval,
  readCostSheet,
  previewPoSubmission,
  savePoApproval,
  saveTnaLeadtimes,
  setPoClosure,
  submitPoApproval,
} from '@/lib/forms/actions';
import { addMonths, canApprove, canDeletePo, canEdit, isPlanFrozen, monthLabel, monthStart, routeApproval, STATUS_LABEL } from '@/lib/forms/approval';
import { addTnaDays, awaitingEasycomDays, tnaBaseFor } from '@/lib/business-logic';
import type { CostSheetFigures } from '@/lib/cost-sheet';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { DeboardedPill } from '@/components/forms/deboarded-pill';
import { InfoDot } from '@/components/info-dot';
import { SubmitChecksModal } from './submit-checks-modal';
import { DeleteRequestModal } from './delete-request-modal';
import { VendorHistoryButton } from '@/components/vendor-history-modal';
import { Combobox, type ComboOption } from '@/components/forms/combobox';
import { PoCard, poFlag } from './po-card';
import { PoLinesPanel } from './po-lines-panel';
import type { PoSubmissionChecks } from '@/lib/forms/queries-modules/po-checks';
import type {
  ApprovalQueueItem,
  DeboardedVendor,
  DeletedPoRequest,
  PoApproval,
  PoDeleteRequest,
  PoApprovalLine,
  PoCategory,
  PoCycleTime,
  PoSubmissionGroup,
  PoType,
  SdRole,
  TnaLeadtimes,
} from '@/lib/forms/types';
import type { PlanMembership } from '@/lib/forms/analysis-types';

const PO_TYPES: { value: PoType; label: string }[] = [
  { value: 'FOB', label: 'FOB' },
  { value: 'job_work', label: 'Job Work' },
  { value: 'efob', label: 'E-FOB' },
];
const CATEGORIES: { value: PoCategory; label: string; hint: string }[] = [
  { value: 'fg', label: 'FG (finished goods)', hint: 'Checks TNA + vendor allocation · ≤5000 team, >5000 admin' },
  { value: 'mat', label: 'Material / Fabric', hint: 'Checks quantity · 2-level (admin) always' },
  { value: 'npd', label: 'NPD', hint: 'Checks cost · 2-level (admin) always' },
];

const BLANK = {
  po_type: '' as PoType | '',
  category: 'fg' as PoCategory,
  product_code: '',
  vendor_code: '',
  vendor_name: '',
  tna_sheet_url: '',
  cost_sheet_url: '',
  rate: '',
  // Per-PO cost pivot (spec §5): commodity params (informational) + CM (gated).
  grey_cost: '',
  finished_fabric_cost: '',
  cm_cost: '',
  margin_pct: '',
  po_qty: '',
  cad_folder_url: '',
  // Spec 7.3 — the critical path is entered as days from the EasyCom PO issue date.
  tna_days_pp_sample: '',
  tna_days_gpt: '',
  tna_days_cutting: '',
  tna_days_inline_qc: '',
  tna_days_first_delivery: '',
  tna_days_po_closing: '',
  // The plan month this PO draws on — defaults to the current month (closed months are locked).
  buying_plan_no: monthStart().slice(0, 7),
  // Optional: why this PO is outside the buying plan (ad-hoc), e.g. urgent replenishment.
  ad_hoc_reason: '',
};

// Quick reasons for an ad-hoc (outside-the-plan) PO; "Other" lets the team type their own.
const AD_HOC_REASONS = ['Urgent replenishment', 'Stock ran out', 'New product / NPD', 'Customer or channel order', 'Plan missed this product'];

/**
 * The critical path, stage by stage, as day counts from the EasyCom PO issue date
 * (spec 7.3). `standard` names the matching column on the standard lead-times, which is
 * what the placeholder and the "use the standard" button fill from.
 */
const TNA_DAY_FIELDS = [
  { key: 'tna_days_pp_sample', label: 'PP sample', standard: 'pp_sample_days' },
  { key: 'tna_days_gpt', label: 'GPT', standard: 'gpt_days' },
  { key: 'tna_days_cutting', label: 'Cutting start', standard: 'cutting_days' },
  { key: 'tna_days_inline_qc', label: 'Inline QC', standard: 'inline_qc_days' },
  { key: 'tna_days_first_delivery', label: 'First delivery', standard: 'first_delivery_days' },
  { key: 'tna_days_po_closing', label: 'PO closing', standard: 'po_closing_days' },
] as const satisfies ReadonlyArray<{
  key: keyof typeof BLANK;
  label: string;
  standard: keyof TnaLeadtimes;
}>;

/** The IST calendar date of a stored timestamp — the three date logs are read as dates. */
const dateOnly = (ts: string | null | undefined) =>
  ts ? new Date(new Date(ts).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10) : null;

/** "6 Sep 26" — a derived date, shown beside the days that produced it. */
const dayLabel = (iso: string | null) =>
  iso
    ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      })
    : '—';

type Filter = 'mine' | 'draft' | 'waiting' | 'approved' | 'issued' | 'all';
const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
/** ₹1.42 Cr / ₹8.3 L / ₹64,300 — the short money form the tiles use. */
const inrShort = (v: number) =>
  v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : inr(v);

/** A raised PO as the form holds it — for Edit (list drawer) and ?edit= (from the PO's page). */
function formFromPo(po: PoApproval): typeof BLANK {
  return {
    ...BLANK,
    po_type: (po.po_type ?? '') as PoType | '',
    category: (po.category ?? 'fg') as PoCategory,
    product_code: po.product_code ?? '',
    vendor_code: po.vendor_code ?? '',
    vendor_name: po.vendor_name ?? '',
    tna_sheet_url: po.tna_sheet_url ?? '',
    cost_sheet_url: po.cost_sheet_url ?? '',
    rate: po.rate != null ? String(po.rate) : '',
    grey_cost: po.grey_cost != null ? String(po.grey_cost) : '',
    finished_fabric_cost: po.finished_fabric_cost != null ? String(po.finished_fabric_cost) : '',
    cm_cost: po.cm_cost != null ? String(po.cm_cost) : '',
    margin_pct: po.margin_pct != null ? String(po.margin_pct) : '',
    po_qty: po.po_qty != null ? String(po.po_qty) : '',
    cad_folder_url: po.cad_folder_url ?? '',
    // The stage days as stored; the dates on the row are what these produced.
    tna_days_pp_sample: po.tna_days_pp_sample != null ? String(po.tna_days_pp_sample) : '',
    tna_days_gpt: po.tna_days_gpt != null ? String(po.tna_days_gpt) : '',
    tna_days_cutting: po.tna_days_cutting != null ? String(po.tna_days_cutting) : '',
    tna_days_inline_qc: po.tna_days_inline_qc != null ? String(po.tna_days_inline_qc) : '',
    tna_days_first_delivery: po.tna_days_first_delivery != null ? String(po.tna_days_first_delivery) : '',
    tna_days_po_closing: po.tna_days_po_closing != null ? String(po.tna_days_po_closing) : '',
    buying_plan_no: po.buying_plan_no ?? monthStart().slice(0, 7),
    ad_hoc_reason: po.ad_hoc_reason ?? '',
  };
}

/** One labelled part of the raise-a-PO form. The form is long; sections make it read as the
 *  steps people actually think in rather than one wall of fields. Each one folds away —
 *  the first is open so the form still starts with something to fill in.
 *  The fields stay mounted while folded, so a collapsed section keeps whatever is typed in it. */
type StepStatus = { tone: 'ok' | 'warn' | 'none'; label: string };
type StepKey = 'order' | 'cost' | 'tna' | 'plan' | 'lines';
const STEP_ORDER: StepKey[] = ['order', 'cost', 'tna', 'plan', 'lines'];

/** The tab strip across the top of the form: one numbered tab per step, with what it still needs. */
function StepTabs({
  steps,
  active,
  onSelect,
}: {
  steps: { key: StepKey; n: number; title: string; status?: StepStatus; disabled?: boolean; disabledWhy?: string }[];
  active: StepKey;
  onSelect: (k: StepKey) => void;
}) {
  return (
    <div className="poa-steptabs" role="tablist" aria-label="Raise a PO — steps">
      {steps.map((st) => (
        <button
          key={st.key}
          type="button"
          role="tab"
          aria-selected={active === st.key}
          className={`poa-steptab${active === st.key ? ' is-active' : ''}${st.status ? ` is-${st.status.tone}` : ''}`}
          onClick={() => onSelect(st.key)}
          disabled={st.disabled}
          title={st.disabled ? st.disabledWhy : st.status?.label}
        >
          <span className="poa-step-no" aria-hidden="true">{st.status?.tone === 'ok' ? '✓' : st.n}</span>
          <span className="poa-steptab-text">
            <span className="wf-form-section-title">{st.title}</span>
            {st.status && <span className={`poa-step-status is-${st.status.tone}`}>{st.status.label}</span>}
          </span>
        </button>
      ))}
    </div>
  );
}

/** One step's fields. Only the active step is shown; the others stay mounted so nothing typed is lost. */
function FormSection({
  active,
  hint,
  children,
}: {
  active: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="poa-steppanel" role="tabpanel" hidden={!active}>
      {hint && <p className="wf-subtle poa-steppanel-hint">{hint}</p>}
      <div className="wf-form-grid">{children}</div>
    </section>
  );
}

export function PoApprovalClient({
  pos,
  cycle,
  linesByPo,
  capacity,
  productCodes,
  vendorCodes,
  vendorNames = {},
  vendorTypes = {},
  productNames = {},
  deboarded = {},
  submissions = [],
  leadtimes,
  stdCm = {},
  role,
  userEmail = null,
  deletedRequests = [],
  deleteRequests = {},
  reviewById = {},
  initialEditId = null,
}: {
  pos: PoApproval[];
  cycle: Record<string, PoCycleTime>;
  linesByPo: Record<string, PoApprovalLine[]>;
  capacity: Record<string, number>;
  productCodes: string[];
  vendorCodes: string[];
  vendorNames?: Record<string, string>;
  /** PO type each vendor mainly works on, from the vendor master. */
  vendorTypes?: Record<string, string>;
  /** Product name per code, from the product catalog. */
  productNames?: Record<string, string>;
  /** Approved de-boardings by upper-cased code — the vendor is flagged, not hidden. */
  deboarded?: Record<string, DeboardedVendor>;
  submissions?: PoSubmissionGroup[];
  leadtimes?: TnaLeadtimes;
  stdCm?: Record<string, number>;
  role: SdRole;
  /** Who is looking — a request can be deleted by the person who raised it. */
  userEmail?: string | null;
  /** Admin only: the deleted-requests log (empty for everyone else). */
  deletedRequests?: DeletedPoRequest[];
  /** Latest deletion request per PO id — a pending one is waiting with the admin. */
  deleteRequests?: Record<string, PoDeleteRequest>;
  /** The queue's review item per PO id (submitted / pending_l2 only) — the four panels + lines. */
  reviewById?: Record<string, ApprovalQueueItem>;
  /** ?edit=<id> — the PO's own page sends people here to edit; the drawer opens on it. */
  initialEditId?: number | null;
}) {
  const editable = canEdit(role, 'draft');
  const initialEdit = initialEditId != null ? pos.find((p) => p.id === initialEditId && (p.status === 'draft' || p.status === 'rework')) ?? null : null;
  const [form, setForm] = useState(() => (initialEdit ? formFromPo(initialEdit) : { ...BLANK }));
  // The page: which POs are listed, the search, the tab, and whether the raise-a-PO drawer is open.
  const [filter, setFilter] = useState<Filter>('mine');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'pos' | 'closure' | 'deleted'>('pos');
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialEdit) && editable);
  // Which step of the form is showing, and the draft a first save created (so later saves
  // update it and the SKU step can open on it before the list has refreshed).
  const [activeStep, setActiveStep] = useState<StepKey>('order');
  const [draftId, setDraftId] = useState<number | null>(null);
  // One clock read for the page's "this month" and "older than a week" figures.
  const [now] = useState(() => Date.now());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (k: keyof typeof BLANK, v: string) =>
    setForm((f) => ({ ...f, [k]: v }));

  // Vendor: code is primary, name auto-fills; and typing a name back-fills the
  // code. Both are shown together. Name → code reverse lookup off the master.
  const nameToCode = useMemo(() => {
    const m: Record<string, string> = {};
    for (const [code, name] of Object.entries(vendorNames)) if (name) m[name] = code;
    return m;
  }, [vendorNames]);
  const setVendorCode = (code: string) =>
    setForm((f) => ({ ...f, vendor_code: code, vendor_name: vendorNames[code.trim()] ?? f.vendor_name }));
  const setVendorName = (name: string) =>
    setForm((f) => ({ ...f, vendor_name: name, vendor_code: nameToCode[name.trim()] ?? f.vendor_code }));

  // Reading the cost sheet: the figures found, and the paste fallback for a sheet that is
  // not open to anyone with the link.
  const [sheetRead, setSheetRead] = useState<CostSheetFigures | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [sheetPaste, setSheetPaste] = useState('');
  const [sheetPasteOpen, setSheetPasteOpen] = useState(false);

  /**
   * Fill the cost fields from the sheet. Only figures the sheet actually carries are
   * written — a blank row leaves whatever is in the form alone rather than wiping it.
   */
  function readSheet(pasted?: string) {
    setError(null);
    setMessage(null);
    setSheetBusy(true);
    const fd = new FormData();
    if (pasted) fd.set('pasted', pasted);
    else fd.set('url', form.cost_sheet_url.trim());
    start(async () => {
      const res = await readCostSheet(fd);
      setSheetBusy(false);
      if (!res.ok) {
        setSheetRead(null);
        setSheetPasteOpen(true); // the usual fix is to paste it
        setError(toastError(res.error));
        return;
      }
      const f = res.figures;
      setSheetRead(f);
      setForm((cur) => ({
        ...cur,
        rate: f.rate != null ? String(f.rate) : cur.rate,
        cm_cost: f.cmCost != null ? String(f.cmCost) : cur.cm_cost,
        finished_fabric_cost: f.fabricCost != null ? String(f.fabricCost) : cur.finished_fabric_cost,
        grey_cost: f.greyCost != null ? String(f.greyCost) : cur.grey_cost,
        margin_pct: f.marginPct != null ? String(f.marginPct) : cur.margin_pct,
      }));
      if (pasted) setSheetPasteOpen(false);
    });
  }

  // Spec 7.3 — the critical path is a set of day counts, filled once. This drops the
  // standard lead times in; each one can then be changed for this PO.
  function useStandardTna() {
    if (!leadtimes) return;
    setForm((f) => {
      const next = { ...f };
      for (const fld of TNA_DAY_FIELDS) {
        const std = leadtimes[fld.standard];
        next[fld.key] = std == null ? '' : String(std);
      }
      return next;
    });
    setMessage('Standard lead times filled — change any stage that differs for this PO.');
  }

  const buildPayload = () => {
    const p = new FormData();
    Object.entries(form).forEach(([k, v]) => p.set(k, v));
    // With an id the server updates that request (draft / rework only) instead of raising
    // another one — same validation either way. `editing` is declared below; by the time
    // this runs (a click) it is set.
    const id = editing?.id ?? draftId;
    if (id != null) p.set('id', String(id));
    return p;
  };

  /** Load a raised PO back into the form. Only a draft or a reworked PO gets here. */
  function startEdit(po: PoApproval) {
    setError(null);
    setMessage(null);
    setEditing(po);
    setForm(formFromPo(po));
    setDraftId(null);
    setActiveStep('order');
    setDrawerOpen(true);
    if (typeof window !== 'undefined') window.scrollTo({ top: 0 });
  }

  function cancelEdit() {
    setEditing(null);
    setDraftId(null);
    setActiveStep('order');
    setForm({ ...BLANK });
    setError(null);
    setMessage(null);
    setDrawerOpen(false);
  }

  // Deleting the request being edited — the only place a request can be deleted from.
  const [deleting, setDeleting] = useState(false);
  function confirmDelete(reason: string) {
    if (!editing) return;
    setError(null);
    const p = new FormData();
    p.set('id', String(editing.id));
    p.set('delete_reason', reason);
    start(async () => {
      const res = await deletePoApproval(p);
      if (res.ok) {
        // reloadWithToast only soft-refreshes (router.refresh), which keeps client state on
        // purpose — so close the dialog and leave edit mode ourselves. Without this the form
        // stays open on a request that no longer exists.
        setDeleting(false);
        cancelEdit();
        reloadWithToast(res.message ?? 'Request deleted.');
      } else {
        setDeleting(false);
        setError(toastError(res.error));
      }
    });
  }

  // Spec 7.1: submit = save the draft, show the three validations as a pop-up, confirm
  // with a remark, then route it for approval.
  const [checks, setChecks] = useState<{ id: number; checks: PoSubmissionChecks } | null>(null);
  // A raised PO stays editable until it is submitted: Edit on its row loads it back here.
  const [editing, setEditing] = useState<PoApproval | null>(initialEdit);
  // The request this form is about: the one being edited, or the draft the first save made.
  const current: PoApproval | null = editing ?? (draftId != null ? pos.find((p) => p.id === draftId) ?? null : null);
  // The latest deletion ask for the request being edited: pending = sitting with the admin,
  // rejected = they said no and it can be asked again.
  const latestDelete = editing ? deleteRequests[String(editing.id)] : undefined;
  const pendingDelete =
    latestDelete && (latestDelete.status === 'submitted' || latestDelete.status === 'pending_l2')
      ? latestDelete
      : null;
  const declinedDelete = latestDelete?.status === 'rejected' ? latestDelete : null;
  // What the stage dates are counted from: the EasyCom issue date once the PO exists
  // there, otherwise today — the honest "if it issued now" projection.
  const tnaBase = tnaBaseFor({ po_issued_at: current?.po_issued_at ?? null });
  /** Save this step and move to the next tab. The first save creates the draft (Request ID). */
  function saveAndNext(next: StepKey) {
    setError(null);
    setMessage(null);
    start(async () => {
      const saved = await savePoApproval(buildPayload());
      if (!saved.ok) return setError(toastError(saved.error));
      if (!editing && saved.id) setDraftId(saved.id);
      setActiveStep(next);
      reloadWithToast(saved.message ?? 'Saved.');
    });
  }
  function run(submitAfter: boolean) {
    setError(null);
    setMessage(null);
    start(async () => {
      const saved = await savePoApproval(buildPayload());
      if (!saved.ok) return setError(toastError(saved.error));
      if (submitAfter && saved.id) {
        const sub = new FormData();
        sub.set('id', String(saved.id));
        const pv = await previewPoSubmission(sub);
        if (!pv.ok) return setError(toastError(pv.error));
        setChecks({ id: saved.id, checks: pv.checks });
        return; // the pop-up takes it from here
      }
      setMessage(saved.message ?? 'Saved.');
      setEditing(null);
      setForm({ ...BLANK });
      setDrawerOpen(false);
      reloadWithToast();
    });
  }
  function confirmSubmit(remark: string) {
    if (!checks) return;
    setError(null);
    start(async () => {
      const sub = new FormData();
      sub.set('id', String(checks.id));
      sub.set('submit_remark', remark);
      const res = await submitPoApproval(sub);
      if (!res.ok) return setError(toastError(res.error));
      setChecks(null);
      setMessage(res.message ?? 'Submitted.');
      setEditing(null);
      setForm({ ...BLANK });
      setDrawerOpen(false);
      reloadWithToast(res.message ?? 'Saved.');
    });
  }

  // Dropdown rows: bold name over a grey detail line.
  const productOptions = useMemo<ComboOption[]>(
    () =>
      productCodes.map((c) => {
        const name = productNames[c.trim().toUpperCase()];
        return { value: c, label: name ? `${c} · ${name}` : c, detail: name ? 'Standard Cost' : 'Standard Cost · no name in the catalog', keywords: name };
      }),
    [productCodes, productNames],
  );
  const vendorOptions = useMemo<ComboOption[]>(
    () =>
      vendorCodes.map((c) => {
        const name = vendorNames[c];
        const load = capacity[c.toLowerCase()];
        const type = vendorTypes[c];
        const typeLabel = type === 'job_work' ? 'Job Work' : type === 'efob' ? 'E-FOB' : type;
        return {
          value: c,
          label: name || c,
          detail: [c.toUpperCase(), typeLabel, load != null ? `${load.toLocaleString('en-IN')} pcs in process` : null, deboarded[c.toUpperCase()] ? 'DE-BOARDED' : null]
            .filter(Boolean)
            .join(', '),
          keywords: c,
        };
      }),
    [vendorCodes, vendorNames, vendorTypes, capacity, deboarded],
  );

  const liveLoad = form.vendor_code
    ? capacity[form.vendor_code.toLowerCase()]
    : undefined;
  // The team has approved stopping work with this vendor. Say so beside the field; the
  // PO can still be raised (a last, agreed order is a real case) but nobody does it unknowingly.
  const deboardedPick = form.vendor_code ? deboarded[form.vendor_code.trim().toUpperCase()] : undefined;
  const activeCat = CATEGORIES.find((c) => c.value === form.category);
  // Standard CM for the typed product — pre-fills / hints the PO's CM (spec §5).
  const stdCmForProduct = form.product_code ? stdCm[form.product_code.trim()] : undefined;

  // Spec item 6 — is this product in the linked month's buying plan? Display only: an
  // outside-the-plan PO is an ad-hoc purchase and goes through approval like any other.
  const [membership, setMembership] = useState<PlanMembership | null>(null);
  useEffect(() => {
    const code = form.product_code.trim();
    const fd = new FormData();
    fd.set('product_code', code);
    fd.set('buying_plan_no', form.buying_plan_no);
    // Nothing is set synchronously here; a blank code clears the verdict on the next tick.
    const t = setTimeout(() => {
      if (!code) { setMembership(null); return; }
      void checkPlanMembership(fd).then((m) => setMembership(m));
    }, code ? 300 : 0);
    return () => clearTimeout(t);
  }, [form.product_code, form.buying_plan_no]);

  // ---------------------------------------------------------------- the page
  const queued = (p: PoApproval) => p.status === 'submitted' || p.status === 'pending_l2';
  const approvedNotIssued = (p: PoApproval) => p.status === 'approved' && !p.po_issued_at;
  const mine = (p: PoApproval) =>
    (queued(p) && canApprove(role, p.status)) ||
    ((p.status === 'draft' || p.status === 'rework') && editable) ||
    (approvedNotIssued(p) && editable);
  const FILTERS: { key: Filter; label: string; test: (p: PoApproval) => boolean }[] = [
    { key: 'mine', label: 'Needs my action', test: mine },
    { key: 'draft', label: 'Draft', test: (p) => p.status === 'draft' || p.status === 'rework' },
    { key: 'waiting', label: 'Awaiting approval', test: queued },
    { key: 'approved', label: 'Approved, not in EasyCom', test: approvedNotIssued },
    { key: 'issued', label: 'Issued', test: (p) => Boolean(p.po_issued_at) },
    { key: 'all', label: 'All', test: () => true },
  ];
  const needle = q.trim().toLowerCase();
  const inSearch = (p: PoApproval) =>
    !needle ||
    [p.request_id, p.product_code, p.vendor_name, p.vendor_code, p.easycom_po_no, p.po_ref_num]
      .some((v) => (v ?? '').toLowerCase().includes(needle));
  const shown = pos.filter((p) => (FILTERS.find((f) => f.key === filter)?.test(p) ?? true) && inSearch(p));

  // Tiles — every one is a count that exists today, never a dash.
  const tnaToConfirm = pos.filter((p) => queued(p) && !p.tna_confirmed && canApprove(role, p.status)).length;
  const waitingList = pos
    .map((p) => ({ po: p, days: awaitingEasycomDays(p) }))
    .filter((w): w is { po: PoApproval; days: number } => w.days != null)
    .sort((a, b) => b.days - a.days);
  const oldest = waitingList[0] ?? null;
  const monthKey = new Date(now + 5.5 * 3600_000).toISOString().slice(0, 7);
  const issuedThisMonth = pos.filter((p) => p.po_issued_at && dateOnly(p.po_issued_at)?.startsWith(monthKey));
  const issuedPcs = issuedThisMonth.reduce((s, p) => s + Number(p.po_qty || 0), 0);
  const issuedValue = issuedThisMonth.reduce((s, p) => s + Number(p.po_qty || 0) * Number(p.rate || 0), 0);
  const issuedVendors = new Set(issuedThisMonth.map((p) => (p.vendor_code ?? p.vendor_name ?? '').toLowerCase()).filter(Boolean)).size;
  const flagged = pos
    .filter(queued)
    .map((p) => poFlag(p, { deleteRequest: deleteRequests[String(p.id)], review: reviewById[String(p.id)], stdCm: p.product_code ? stdCm[p.product_code.trim()] : undefined, role }))
    .filter((f) => f.tone === 'bad' || f.tone === 'warn');
  const flagCount = (needleText: string) => flagged.filter((f) => f.text.toLowerCase().includes(needleText)).length;
  const deletionsPending = Object.values(deleteRequests).filter((d) => d.status === 'submitted' || d.status === 'pending_l2').length;
  const adHocQueued = pos.filter((p) => queued(p) && p.in_buying_plan === false).length;
  const stale14 = waitingList.filter((w) => w.days > 14).length;
  const oldDrafts = pos.filter((p) => (p.status === 'draft' || p.status === 'rework') && now - Date.parse(p.timestamp_created ?? p.created_at) > 7 * 86_400_000).length;
  const toIssue = pos.filter(approvedNotIssued).sort((a, b) => (a.po_closing_date ?? '9999').localeCompare(b.po_closing_date ?? '9999'));

  // Cycle times, same arithmetic as before: request → approval → EasyCom, and the critical path.
  const cycleRows = Object.values(cycle);
  const avg = (pick: (c: PoCycleTime) => number | null) => {
    const vals = cycleRows.map(pick).filter((v): v is number => v != null);
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  const toApproveDays = avg((c) => c.days_to_approve);
  const toIssueDays = avg((c) => c.days_to_issue);
  const delivered = pos.filter((p) => p.po_issued_at && p.first_actual_delivery_date && p.critical_path_first_delivery);
  const onTime = delivered.filter((p) => (p.first_actual_delivery_date as string) <= (p.critical_path_first_delivery as string)).length;

  // What the approver will see — the live verdicts on the form in the drawer.
  const draftQty = current ? Number(current.po_qty || 0) : 0;
  const draftRate = Number(form.rate) || 0;
  const draftCm = Number(form.cm_cost) || 0;
  const cmAbove = draftCm > 0 && stdCmForProduct != null && draftCm > stdCmForProduct + 0.005;
  const tnaFilled = TNA_DAY_FIELDS.filter((f) => form[f.key] !== '').length;
  const route = routeApproval('po_approval', draftQty, form.category);
  const currentLines = current ? linesByPo[String(current.id)] ?? [] : [];
  // What each step of the form still needs — the chip on its header, live as you type.
  const stepStatus: Record<'order' | 'cost' | 'tna' | 'plan', StepStatus> = (() => {
    const orderMissing = [
      !form.product_code.trim() ? 'product' : null,
      !form.po_type ? 'PO type' : null,
      !form.vendor_code.trim() ? 'vendor' : null,
    ].filter(Boolean) as string[];
    const order: StepStatus = orderMissing.length
      ? { tone: 'none', label: `Needs ${orderMissing.join(', ')}` }
      : { tone: 'ok', label: `${form.product_code.trim().toUpperCase()} · ${form.po_type === 'job_work' ? 'Job Work' : form.po_type === 'efob' ? 'E-FOB' : form.po_type} · ${form.vendor_code.trim().toUpperCase()}` };
    const cost: StepStatus = !draftRate
      ? { tone: 'none', label: 'Needs the rate' }
      : cmAbove
        ? { tone: 'warn', label: `₹${nfmt(draftRate)} / pc · CMTP above standard` }
        : { tone: 'ok', label: `₹${nfmt(draftRate)} / pc${draftCm ? ` · CMTP ₹${nfmt(draftCm)}` : ''}` };
    const tna: StepStatus =
      tnaFilled === TNA_DAY_FIELDS.length
        ? { tone: 'ok', label: `${form.tna_days_first_delivery} d to first delivery` }
        : tnaFilled
          ? { tone: 'warn', label: `${tnaFilled} of ${TNA_DAY_FIELDS.length} stages set` }
          : { tone: 'none', label: 'Needs the stage days' };
    const plan: StepStatus = !form.buying_plan_no
      ? { tone: 'none', label: 'No plan month' }
      : membership && !membership.inPlan
        ? { tone: 'warn', label: `${monthLabel(membership.planMonth)} · ad-hoc${form.ad_hoc_reason.trim() ? '' : ' — reason?'}` }
        : membership && membership.inPlan
          ? { tone: 'ok', label: `In the ${monthLabel(membership.planMonth)} plan` }
          : { tone: 'ok', label: /^\d{4}-\d{2}$/.test(form.buying_plan_no) ? `${monthLabel(`${form.buying_plan_no}-01`)} plan` : form.buying_plan_no };
    return { order, cost, tna, plan };
  })();

  return (
    <>
      {message && <Notice tone="ok">{message}</Notice>}
      {error && !drawerOpen && <Notice tone="error">{error}</Notice>}
      {checks && (
        <SubmitChecksModal checks={checks.checks} pending={pending} onConfirm={confirmSubmit} onCancel={() => setChecks(null)} />
      )}
      {deleting && editing && (
        <DeleteRequestModal
          requestId={editing.request_id}
          productCode={editing.product_code}
          statusLabel={STATUS_LABEL[editing.status]}
          needsApproval={role !== 'admin'}
          pending={pending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(false)}
        />
      )}

      {/* The form takes the page in place of the list — sidebar and header stay. */}
      {!(editable && drawerOpen) && (<>
      <div className="poa-pagebar">
        <div className="poa-segment" role="tablist" aria-label="Filter purchase orders">
          {FILTERS.map((f) => {
            const n = f.key === 'all' ? null : pos.filter(f.test).length;
            return (
              <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? 'active' : ''} onClick={() => setFilter(f.key)}>
                {f.label}{n != null && <span className="c">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="spacer" />
        <label className="poa-search">
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Request, product, vendor, EasyCom PO…" aria-label="Search purchase orders" />
        </label>
        {editable && (
          <button type="button" className="wf-btn wf-btn-primary" onClick={() => { cancelEdit(); setActiveStep('order'); setDrawerOpen(true); window.scrollTo({ top: 0 }); }}>
            <Plus size={14} /> Raise a PO
          </button>
        )}
      </div>

      <div className="poa-tiles">
        <div className={`poa-tile${pos.filter(mine).length ? ' hot' : ''}`}>
          <div className="label">Waiting on me <InfoDot text={"WHAT: POs that need something from you.\n\nHOW: POs you can approve (at their stage), drafts and reworks you can edit, and approved POs still to be linked to an EasyCom PO.\n\nUSE: the 'Needs my action' filter shows exactly these."} /></div>
          <div className="value">{pos.filter(mine).length}</div>
          <div className="sub">{tnaToConfirm ? `${tnaToConfirm} need TNA dates confirmed first` : 'nothing blocked on TNA'}</div>
        </div>
        <div className="poa-tile">
          <div className="label">Approved, not in EasyCom <InfoDot text={"WHAT: approved here, but no PO exists in EasyCom yet, so nothing has started.\n\nHOW: status Approved with no EasyCom PO number; the days count from the approval.\n\nUSE: the critical path cannot begin until the PO is created there — link it from the card."} /></div>
          <div className="value">{waitingList.length}{oldest && <small>oldest {oldest.days} d</small>}</div>
          <div className="sub">{oldest ? `${oldest.po.request_id} since ${dayLabel(dateOnly(oldest.po.approved_at))}` : 'every approved PO is in EasyCom'}</div>
        </div>
        <div className="poa-tile">
          <div className="label">Issued this month <InfoDot text={"WHAT: POs created in EasyCom this calendar month.\n\nHOW: count, pieces, and value = pieces × rate on the PO.\n\nUSE: the pace of ordering against the buying plan."} /></div>
          <div className="value">{issuedThisMonth.length}{issuedValue > 0 && <small>{inrShort(issuedValue)}</small>}</div>
          <div className="sub">{issuedThisMonth.length ? `${nfmt(issuedPcs)} pcs · ${issuedVendors} vendor${issuedVendors === 1 ? '' : 's'}` : 'none yet this month'}</div>
        </div>
        <div className="poa-tile">
          <div className="label">Flags on POs awaiting approval <InfoDot text={"WHAT: how many POs in the queue carry a warning.\n\nHOW: TNA dates not confirmed, vendor over capacity with this PO, CMTP above the standard, outside the buying plan, or a deletion request pending.\n\nUSE: each card's pill names its flag; the right column counts them."} /></div>
          <div className="value">{flagged.length}</div>
          <div className="sub">
            {flagged.length
              ? [
                  flagCount('tna') ? `${flagCount('tna')} TNA` : null,
                  flagCount('capacity') ? `${flagCount('capacity')} over capacity` : null,
                  flagCount('standard') ? `${flagCount('standard')} above standard` : null,
                  flagCount('not in plan') ? `${flagCount('not in plan')} not in plan` : null,
                  flagCount('deletion') ? `${flagCount('deletion')} deletion` : null,
                ].filter(Boolean).join(' · ')
              : 'nothing flagged in the queue'}
          </div>
        </div>
      </div>

      <div className="poa-layout">
        <section>
          <div className="poa-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'pos'} className={tab === 'pos' ? 'active' : ''} onClick={() => setTab('pos')}>
              Purchase orders <span className="c">{pos.length}</span>
            </button>
            <button type="button" role="tab" aria-selected={tab === 'closure'} className={tab === 'closure' ? 'active' : ''} onClick={() => setTab('closure')}>
              Submission &amp; closure <span className="c">{submissions.length} open</span>
            </button>
            {role === 'admin' && (
              <button type="button" role="tab" aria-selected={tab === 'deleted'} className={tab === 'deleted' ? 'active' : ''} onClick={() => setTab('deleted')}>
                Deleted requests <span className="c">{deletedRequests.length}</span>
              </button>
            )}
          </div>

          {tab === 'pos' && (
            <div className="poa-list">
              {shown.map((po, i) => (
                <PoCard
                  key={po.id}
                  po={po}
                  cycle={cycle[String(po.id)]}
                  lines={linesByPo[String(po.id)] ?? []}
                  role={role}
                  deleteRequest={deleteRequests[String(po.id)]}
                  review={reviewById[String(po.id)]}
                  stdCm={stdCm}
                  onEdit={startEdit}
                  editingId={editing?.id ?? null}
                  defaultOpen={i === 0 && filter === 'mine'}
                />
              ))}
              {!shown.length && (
                <div className="poa-empty">
                  {pos.length ? 'Nothing in this view.' : 'No POs raised yet.'}
                </div>
              )}
            </div>
          )}
          {tab === 'closure' && <PoSubmissionTable submissions={submissions} editable={editable} />}
          {tab === 'deleted' && role === 'admin' && <DeletedRequestsTable rows={deletedRequests} />}
        </section>

        <aside className="poa-rail">
          <div className="panel">
            <div className="panel-title"><h3>Needs attention</h3><span>open POs</span></div>
            <div className="panel-body poa-attn">
              <a href="#" className={tnaToConfirm ? 'warn' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('mine'); }}><span>TNA dates to confirm</span><b>{tnaToConfirm}</b></a>
              <a href="#" className={flagCount('capacity') ? 'bad' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('waiting'); }}><span>Vendor over capacity</span><b>{flagCount('capacity')}</b></a>
              <a href="#" className={flagCount('standard') ? 'warn' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('waiting'); }}><span>CMTP above standard</span><b>{flagCount('standard')}</b></a>
              <a href="#" className={adHocQueued ? 'warn' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('waiting'); }}><span>Outside the buying plan</span><b>{adHocQueued}</b></a>
              <a href="#" className={deletionsPending ? 'bad' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('all'); }}><span>Deletion requests pending</span><b>{deletionsPending}</b></a>
              <a href="#" className={stale14 ? 'warn' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('approved'); }}><span>Approved &gt; 14 d, not in EasyCom</span><b>{stale14}</b></a>
              <a href="#" className={oldDrafts ? 'warn' : ''} onClick={(e) => { e.preventDefault(); setTab('pos'); setFilter('draft'); }}><span>Drafts older than a week</span><b>{oldDrafts}</b></a>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">
              <h3>To issue <InfoDot text={"WHAT: approved POs with no EasyCom PO yet, soonest closing date first.\n\nHOW: status Approved, no EasyCom PO number recorded.\n\nUSE: the queue to clear — link each one from its card."} /></h3>
              <span>{toIssue.length} approved</span>
            </div>
            <div className="panel-body poa-week">
              {toIssue.slice(0, 7).map((p) => (
                <div key={p.id}>
                  <span className="d">{p.po_closing_date ? dayLabel(p.po_closing_date) : '—'}</span>
                  <span className="n">{p.request_id} · {p.vendor_name || p.vendor_code || '—'}</span>
                  <span className="v">{nfmt(Number(p.po_qty || 0))} pcs</span>
                </div>
              ))}
              {!toIssue.length && <p className="wf-subtle" style={{ margin: '6px 0 0' }}>Nothing waiting to be issued.</p>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">
              <h3>Cycle times <InfoDot text={"WHAT: how long a PO takes to move.\n\nHOW: request → approval and approval → EasyCom PO, averaged over the POs that have those dates. Critical path met = issued POs whose actual first delivery was on or before the approved date.\n\nUSE: the middle gap is ours alone — an approval with no EasyCom PO behind it has started nothing."} /></h3>
              <span>all POs</span>
            </div>
            <div className="panel-body poa-kv">
              <span>Request → approval</span><span>{toApproveDays == null ? 'no data' : `${toApproveDays} d`}</span>
              <span>Approval → EasyCom PO</span><span>{toIssueDays == null ? 'no data' : `${toIssueDays} d`}</span>
              <span>Critical path met</span><span>{delivered.length ? `${onTime} of ${delivered.length}` : 'none delivered yet'}</span>
            </div>
          </div>

          {editable && leadtimes && <TnaLeadtimesPanel leadtimes={leadtimes} />}
        </aside>
      </div>

      </>)}

      {editable && drawerOpen && (
        <>
          <div className="poa-drawer" role="region" aria-label={editing ? `Edit ${editing.request_id}` : 'Raise a PO'}>
            <div className="poa-drawer-head">
              <h2>{current ? `${editing ? 'Edit' : 'Raise'} ${current.request_id}` : 'Raise a PO'}</h2>
              <span className="wf-subtle">Five steps — each Save &amp; continue saves what is filled and opens the next.</span>
              <div className="spacer" />
              <button type="button" className="wf-btn wf-btn-sm" onClick={cancelEdit} disabled={pending}>
                <X size={14} /> Close
              </button>
            </div>
            <div className="poa-drawer-body">
              <div>
                {error && <Notice tone="error">{error}</Notice>}
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <div>
              <h3>
                {editing ? `Edit ${editing.request_id}` : 'Raise a PO for approval'}
                <InfoDot text={"WHAT: where a PO is drafted before it exists in EasyEcom.\n\nHOW: quantities by colour and size, the rate against the approved Standard Cost, and the TNA timeline. Submitting sends it to Approvals — FG under 5,000 pieces to the team, larger or NPD/material to an admin.\n\nUSE: a raised PO stays editable until it is submitted — use Edit on its row. Nothing is issued to the vendor until it is approved and then issued here against a real EasyEcom PO number."} />
              </h3>
              {editing && (
                <p className="wf-subtle">
                  Editing a saved request{editing.status === 'rework' ? ' sent back for rework' : ''} — saving updates it
                  rather than raising another. Its SKU quantities stay as they are.
                </p>
              )}
            </div>
            {/* Delete lives here and nowhere else: you open the request to edit it, and the one
                destructive action sits in the corner of that box — never next to Submit in a row.
                Deletion goes through the admin, so while an ask is pending the button is replaced
                by what is waiting on. */}
            {editing && pendingDelete ? (
              <span className="wf-tag-pending" title={`Reason given: ${pendingDelete.reason}`}>
                Deletion waiting with admin
              </span>
            ) : (
              editing &&
              canDeletePo(role, editing.status, editing.created_by, userEmail) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-sm wf-btn-delete"
                  onClick={() => setDeleting(true)}
                  disabled={pending}
                  aria-label={`Delete ${editing.request_id}`}
                  title={
                    role === 'admin'
                      ? `Delete ${editing.request_id} — a reason is required`
                      : `Ask the admin to delete ${editing.request_id} — a reason is required`
                  }
                >
                  <Trash2 size={15} /> {role === 'admin' ? 'Delete request' : 'Request deletion'}
                </button>
              )
            )}
          </div>
          {pendingDelete && (
            <Notice tone="warn">
              <strong>Deletion requested</strong> by {pendingDelete.requested_by} on{' '}
              {new Date(pendingDelete.requested_at).toLocaleDateString('en-IN')} — “{pendingDelete.reason}”.
              It is in the admin’s approval queue; the request stays live until they decide.
            </Notice>
          )}
          {declinedDelete && (
            <Notice tone="info">
              An earlier request to delete this was <strong>declined</strong>
              {declinedDelete.rejection_notes ? `: ${declinedDelete.rejection_notes}` : ''}. You can ask again if
              something has changed.
            </Notice>
          )}
          <StepTabs
            active={activeStep}
            onSelect={setActiveStep}
            steps={[
              { key: 'order', n: 1, title: 'Order', status: stepStatus.order },
              { key: 'cost', n: 2, title: 'Cost', status: stepStatus.cost },
              { key: 'tna', n: 3, title: 'Timeline (TNA)', status: stepStatus.tna },
              { key: 'plan', n: 4, title: 'Plan', status: stepStatus.plan },
              {
                key: 'lines',
                n: 5,
                title: 'SKU quantities',
                status: current
                  ? currentLines.length
                    ? { tone: 'ok', label: `${currentLines.length} lines · ${nfmt(Number(current.po_qty || 0))} pcs` }
                    : { tone: 'none', label: 'None yet' }
                  : { tone: 'none', label: 'After the first save' },
                disabled: !current,
                disabledWhy: 'Save the order first — the quantities go on the request once it exists.',
              },
            ]}
          />
          <FormSection
            active={activeStep === 'order'}
            hint="What is being bought, and from whom. Category and PO type decide how it is approved and how long it takes."
          >
            <Field label="Category" hint={activeCat?.hint}>
              <select
                value={form.category}
                onChange={(e) => set('category', e.target.value)}
              >
                {CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="PO type">
              <select
                value={form.po_type}
                onChange={(e) => set('po_type', e.target.value)}
              >
                <option value="">Select…</option>
                {PO_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Product code">
              <Combobox
                ariaLabel="Product code"
                value={form.product_code}
                onChange={(v) => set('product_code', v)}
                // A PO is raised against a costed product (EasyEcom or TMP), never a typed name.
                allowFreeText={false}
                emptyText="No costed product matches. Add it on Standard Cost first."
                placeholder="Search code or product name…"
                options={productOptions}
              />
            </Field>
            <Field
              label="Request ID"
              hint={current ? 'Assigned when this request was saved' : 'Assigned when you save — the EasyCom PO number is linked to it at issuance'}
            >
              <input value={current ? current.request_id : 'Assigned on save'} disabled readOnly className="wf-fixed-value" />
            </Field>
            <Field
              label="Vendor code"
              hint={
                liveLoad != null
                  ? `Live load: ${liveLoad.toLocaleString('en-IN')} pcs in process`
                  : 'Pick a code — name fills itself'
              }
            >
              <Combobox
                ariaLabel="Vendor"
                value={form.vendor_code}
                onChange={(v) => setVendorCode(v)}
                placeholder="Search vendor name or code…"
                options={vendorOptions}
              />
              {deboardedPick && (
                <Notice tone="warn">
                  <DeboardedPill flag={deboardedPick} /> This vendor’s de-boarding was approved.
                  Raise a PO to them only if it is a deliberately agreed last order.
                </Notice>
              )}
              {/* Spec 7.8 — what this vendor has actually taken, PO by PO, before you commit. */}
              {form.vendor_code.trim() && (
                <VendorHistoryButton
                  vendorCode={form.vendor_code}
                  productCode={form.product_code.trim().toUpperCase() || null}
                  label="See their PO history"
                />
              )}
            </Field>
            <Field label="Vendor name" hint="fills itself from the vendor picked — type only if the vendor is not in the master">
              <input
                value={form.vendor_name}
                placeholder="Fills from the vendor"
                onChange={(e) => setVendorName(e.target.value)}
              />
            </Field>
          </FormSection>

          <FormSection
            active={activeStep === 'cost'}
            hint="Start with the cost sheet — read it in and the figures below fill themselves. Per piece: the rate is checked against the approved Standard Cost when you submit, CMTP is what the vendor controls, grey and fabric are commodity."
          >
            <Field
              label="Cost sheet link"
              hint="the sheet the costs were agreed on — read it in rather than re-typing"
            >
              <div className="wf-issue-row">
                <input
                  value={form.cost_sheet_url}
                  placeholder="https://…"
                  onChange={(e) => set('cost_sheet_url', e.target.value)}
                />
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => readSheet()}
                  disabled={sheetBusy || !form.cost_sheet_url.trim()}
                  title="Read the rate, CMTP, fabric cost and margin off the sheet"
                >
                  <FileSpreadsheet size={13} /> {sheetBusy ? 'Reading…' : 'Read the sheet'}
                </button>
              </div>
            </Field>

            {/* The figures are only ever suggested: what was taken, and from where, is
                spelled out so it can be checked against the sheet in one glance. */}
            <div style={{ gridColumn: '1 / -1' }}>
              {sheetRead && (
                <Notice tone={sheetRead.warnings.length ? 'warn' : 'ok'}>
                  <strong>Read from the cost sheet</strong>
                  {sheetRead.poRef ? ` (${sheetRead.poRef})` : ''}
                  {sheetRead.avgColumnLabel ? ` — ${sheetRead.avgColumnLabel} column` : ''}:{' '}
                  {[
                    sheetRead.rate != null ? `rate ₹${sheetRead.rate}` : null,
                    sheetRead.cmCost != null ? `CMTP ₹${sheetRead.cmCost}` : null,
                    sheetRead.fabricCost != null ? `fabric ₹${sheetRead.fabricCost}` : null,
                    sheetRead.greyCost != null ? `greige ₹${sheetRead.greyCost}` : null,
                    sheetRead.marginPct != null ? `margin ${sheetRead.marginPct}%` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'nothing could be read'}
                  . Check them against the sheet and change anything that is wrong.
                  {sheetRead.paymentTermsDays != null && (
                    <>
                      {' '}
                      The sheet also says <strong>payment terms {sheetRead.paymentTermsDays} days</strong>, which this
                      form does not hold.
                    </>
                  )}
                  {sheetRead.warnings.length > 0 && <> {sheetRead.warnings.join(' ')}</>}
                </Notice>
              )}
              {sheetPasteOpen ? (
                <Field
                  label="Paste the cost sheet"
                  hint="select the sheet in Google Sheets (Ctrl+A), copy, paste here — it is read for its figures and not stored; nothing is saved to the PO until you press Save"
                >
                  <div className="wf-issue-row">
                    <textarea
                      className="wf-textarea"
                      rows={3}
                      value={sheetPaste}
                      placeholder="Paste the whole sheet…"
                      onChange={(e) => setSheetPaste(e.target.value)}
                    />
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      onClick={() => readSheet(sheetPaste)}
                      disabled={sheetBusy || !sheetPaste.trim()}
                    >
                      Read it
                    </button>
                  </div>
                </Field>
              ) : (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setSheetPasteOpen(true)}
                >
                  Sheet not shared? Paste it instead
                </button>
              )}
            </div>
            <Field label="Rate" hint="filled with the cost sheet — required to submit">
              <input
                type="number"
                min={0}
                value={form.rate}
                placeholder="e.g. 265"
                onChange={(e) => set('rate', e.target.value)}
              />
            </Field>
            <Field
              label="CMTP cost (this PO)"
              hint={
                stdCmForProduct != null
                  ? `standard CMTP ${stdCmForProduct}`
                  : 'the FINAL CMTP figure for this PO'
              }
            >
              <div className="wf-issue-row">
                <input
                  type="number"
                  min={0}
                  value={form.cm_cost}
                  placeholder="e.g. 92"
                  onChange={(e) => set('cm_cost', e.target.value)}
                />
                {stdCmForProduct != null && (
                  <button
                    type="button"
                    className="wf-btn wf-btn-ghost wf-btn-sm"
                    title="Fill with the standard CMTP"
                    onClick={() => set('cm_cost', String(stdCmForProduct))}
                  >
                    Use standard
                  </button>
                )}
              </div>
            </Field>
            <Field label="Grey cost (this PO)" hint="commodity — informational, not gated">
              <input
                type="number"
                min={0}
                value={form.grey_cost}
                placeholder="e.g. 270"
                onChange={(e) => set('grey_cost', e.target.value)}
              />
            </Field>
            <Field label="Finished fabric cost (this PO)" hint="commodity — informational">
              <input
                type="number"
                min={0}
                value={form.finished_fabric_cost}
                placeholder="e.g. 180"
                onChange={(e) => set('finished_fabric_cost', e.target.value)}
              />
            </Field>
            <Field label="Margin %" hint="optional">
              <input
                type="number"
                min={0}
                value={form.margin_pct}
                placeholder="e.g. 5"
                onChange={(e) => set('margin_pct', e.target.value)}
              />
            </Field>
          </FormSection>

          <FormSection
            active={activeStep === 'tna'}
            hint="Days, not dates. Nothing can start before the PO exists in EasyCom, so every stage is counted from the day it is created there — fill these once and the dates follow, however late the PO issues."
          >
            <div style={{ gridColumn: '1 / -1' }}>
              <Notice tone={tnaBase.source === 'issued' ? 'ok' : 'info'}>
                {tnaBase.source === 'issued' ? (
                  <>
                    Counting from the <strong>EasyCom PO issue date, {dayLabel(tnaBase.date)}</strong>.
                  </>
                ) : (
                  <>
                    No EasyCom PO yet, so the dates below are <strong>projected from today</strong> and move with
                    the calendar. They are fixed the day the PO is created in EasyCom.
                  </>
                )}
              </Notice>
            </div>
            {TNA_DAY_FIELDS.map((f) => (
              <Field
                key={f.key}
                label={f.label}
                hint={
                  form[f.key]
                    ? `${dayLabel(addTnaDays(tnaBase.date, Number(form[f.key])))}${
                        leadtimes?.[f.standard] != null ? ` · standard ${leadtimes[f.standard]}d` : ''
                      }`
                    : leadtimes?.[f.standard] != null
                      ? `standard ${leadtimes[f.standard]}d`
                      : 'days from the EasyCom PO'
                }
              >
                <div className="wf-issue-row">
                  <input
                    type="number"
                    min={0}
                    value={form[f.key]}
                    placeholder={leadtimes?.[f.standard] != null ? String(leadtimes[f.standard]) : 'days'}
                    onChange={(e) => set(f.key, e.target.value)}
                  />
                  <span className="wf-subtle">days</span>
                </div>
              </Field>
            ))}
            <div style={{ gridColumn: '1 / -1' }}>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={useStandardTna}
                disabled={!leadtimes}
                title="Fill all six with the standard lead times"
              >
                <CalendarCheck size={13} /> Use the standard lead times
              </button>
            </div>
            <Field label="TNA sheet link" hint="Google Drive">
              <input
                value={form.tna_sheet_url}
                placeholder="https://…"
                onChange={(e) => set('tna_sheet_url', e.target.value)}
              />
            </Field>
            {form.po_type === 'FOB' && (
              <Field label="CAD file folder link" hint="FOB POs only">
                <input
                  value={form.cad_folder_url}
                  placeholder="https://…"
                  onChange={(e) => set('cad_folder_url', e.target.value)}
                />
              </Field>
            )}
          </FormSection>

          <FormSection
            active={activeStep === 'plan'}
            hint="Which month's plan this draws on. The quantity is the sum of the SKU lines — add them on the row after saving."
          >
            <Field label="Buying plan month" hint="The plan this PO draws on — closed months are locked">
              <select value={form.buying_plan_no} onChange={(e) => set('buying_plan_no', e.target.value)}>
                <option value="">— not linked —</option>
                {[0, 1, 2].map((delta) => {
                  const m = addMonths(monthStart(), delta);
                  return (
                    <option key={m} value={m.slice(0, 7)}>
                      {monthLabel(m)} plan
                    </option>
                  );
                })}
                {/* A legacy free-text reference, or a closed month, stays visible so the row still reads correctly. */}
                {form.buying_plan_no && !/^\d{4}-\d{2}$/.test(form.buying_plan_no) && (
                  <option value={form.buying_plan_no}>{form.buying_plan_no} (legacy reference)</option>
                )}
                {/^\d{4}-\d{2}$/.test(form.buying_plan_no) && isPlanFrozen(`${form.buying_plan_no}-01`) && (
                  <option value={form.buying_plan_no}>{monthLabel(`${form.buying_plan_no}-01`)} plan — closed</option>
                )}
              </select>
            </Field>
            <Field label="PO quantity" hint="= sum of size lines (add them on the row after saving)">
              <input type="number" value={form.po_qty} readOnly disabled />
            </Field>

            {/* Spec item 6 — plan membership is shown, never enforced. */}
            {form.product_code.trim() && membership && (
              <div style={{ gridColumn: '1 / -1' }}>
                {membership.inPlan ? (
                  <Notice tone="ok">
                    <strong>{form.product_code.trim()} is in the {monthLabel(membership.planMonth)} buying plan</strong> — approved{' '}
                    {membership.qty.total.toLocaleString('en-IN')} pcs
                    {[
                      membership.qty.job ? `JOB ${membership.qty.job.toLocaleString('en-IN')}` : '',
                      membership.qty.efob ? `E-FOB ${membership.qty.efob.toLocaleString('en-IN')}` : '',
                      membership.qty.fob ? `FOB ${membership.qty.fob.toLocaleString('en-IN')}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')
                      .replace(/^(.)/, ' (') + (membership.qty.total ? ')' : '')}
                    .
                  </Notice>
                ) : (
                  <Notice tone="warn">
                    <strong>
                      {form.product_code.trim()} is outside the {monthLabel(membership.planMonth)} buying plan
                      {membership.linePresent ? ' (listed, but no approved quantity)' : ''}
                      {!membership.planExists ? ' (no plan exists for that month)' : ''}
                    </strong>{' '}
                    — this is an ad-hoc purchase. It goes through approval as usual; give the approver the reason.
                  </Notice>
                )}
                {!membership.inPlan && (
                  <Field label="Reason for the ad-hoc purchase" hint="optional — shown to the approver">
                    <div className="wf-issue-row">
                      <select
                        value={AD_HOC_REASONS.includes(form.ad_hoc_reason) ? form.ad_hoc_reason : form.ad_hoc_reason ? '__other' : ''}
                        onChange={(e) => set('ad_hoc_reason', e.target.value === '__other' ? ' ' : e.target.value)}
                      >
                        <option value="">— pick a reason —</option>
                        {AD_HOC_REASONS.map((r) => (
                          <option key={r} value={r}>{r}</option>
                        ))}
                        <option value="__other">Other…</option>
                      </select>
                      {form.ad_hoc_reason && !AD_HOC_REASONS.includes(form.ad_hoc_reason) && (
                        <input
                          value={form.ad_hoc_reason.trim()}
                          placeholder="type the reason"
                          onChange={(e) => set('ad_hoc_reason', e.target.value || ' ')}
                        />
                      )}
                    </div>
                  </Field>
                )}
              </div>
            )}
          </FormSection>
          {activeStep === 'lines' && (
            <section className="poa-steppanel" role="tabpanel">
              {current ? (
                <>
                  <p className="wf-subtle poa-steppanel-hint">
                    Paste the team’s sheet or fill the size matrix. The PO quantity is the sum of these lines; submit once they are saved.
                  </p>
                  <PoLinesPanel
                    key={current.id}
                    poId={current.id}
                    poRef={current.po_ref_num ?? current.request_id}
                    productCode={form.product_code.trim() || current.product_code}
                    lines={currentLines}
                    editable={current.status === 'draft' || current.status === 'rework'}
                    onSaved={() => reloadWithToast()}
                    onClose={() => setActiveStep('plan')}
                  />
                </>
              ) : (
                <p className="wf-subtle poa-steppanel-hint">Save the order first — the quantities go on the request once it exists.</p>
              )}
            </section>
          )}
          <div className="wf-footer-actions">
            <p className="wf-footer-note">
              {activeStep === 'lines'
                ? currentLines.length
                  ? 'Lines saved. Submit runs the three checks (rate vs standard, vendor load, TNA against the vendor’s history) and routes it by value.'
                  : 'Save the lines above, then submit.'
                : current
                  ? `Saving updates ${current.request_id}. It stays editable until it is submitted.`
                  : 'Save & continue creates the draft and gives it its Request ID; every later save updates it.'}
            </p>
            {STEP_ORDER.indexOf(activeStep) > 0 && (
              <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setActiveStep(STEP_ORDER[STEP_ORDER.indexOf(activeStep) - 1])} disabled={pending}>
                ← Back
              </button>
            )}
            {activeStep !== 'lines' ? (
              <>
                <button type="button" className="wf-btn wf-btn-ghost" onClick={() => run(false)} disabled={pending || !form.product_code} title="Save and close the form">
                  <Save size={15} /> Save &amp; close
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn-primary"
                  onClick={() => saveAndNext(STEP_ORDER[STEP_ORDER.indexOf(activeStep) + 1])}
                  disabled={pending || !form.product_code}
                >
                  {pending ? 'Working…' : activeStep === 'plan' ? 'Save & add SKU quantities →' : 'Save & continue →'}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="wf-btn wf-btn-ghost" onClick={cancelEdit} disabled={pending}>
                  Close
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn-primary"
                  onClick={() => run(true)}
                  disabled={pending || !current || !currentLines.length}
                  title={currentLines.length ? 'Run the three checks and submit' : 'Save the SKU lines first'}
                >
                  <Send size={15} /> {pending ? 'Working…' : 'Submit for approval'}
                </button>
              </>
            )}
          </div>
        </div>
              </div>
              <aside className="poa-summary">
                <div className="panel">
                  <div className="panel-title"><h3>What the approver will see</h3></div>
                  <div className="panel-body">
                    {draftQty && draftRate ? (
                      <div className="big">{inr(draftQty * draftRate)}</div>
                    ) : (
                      <p className="quiet">The value appears once the rate and the SKU lines are in.</p>
                    )}
                    <div className="line"><span>Pieces</span><span>{draftQty ? nfmt(draftQty) : 'after saving'}</span></div>
                    <div className="line"><span>Rate per piece</span><span>{draftRate ? `₹${nfmt(draftRate)}` : 'not yet'}</span></div>
                    <div className="line"><span>CMTP vs standard</span><span>{draftCm ? `₹${nfmt(draftCm)}` : '—'}{stdCmForProduct != null ? ` vs ₹${nfmt(stdCmForProduct)}` : ''}</span></div>
                    <div className="line"><span>Vendor in process</span><span>{liveLoad != null ? `${nfmt(liveLoad)} pcs` : form.vendor_code ? 'no open POs' : '—'}</span></div>
                    <div className="line"><span>TNA stages filled</span><span>{tnaFilled} of {TNA_DAY_FIELDS.length}</span></div>
                    <div className="line"><span>Route</span><span>{route === 'admin' ? 'admin' : 'team'}{!draftQty ? ' (by quantity)' : ''}</span></div>
                    {cmAbove && <span className="wf-verdict is-flag">CMTP above standard — will be flagged</span>}
                    {membership && !membership.inPlan && <span className="wf-verdict is-none">Outside the plan — ad-hoc reason needed</span>}
                    {membership && membership.inPlan && <span className="wf-verdict is-ok">In the {monthLabel(membership.planMonth)} plan</span>}
                    {deboardedPick && <span className="wf-verdict is-flag">Vendor de-boarded</span>}
                  </div>
                </div>
              </aside>
            </div>
          </div>
        </>
      )}
    </>
  );
}

const nfmt = (v: number) => v.toLocaleString('en-IN');

const stamp = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

/**
 * Admin only: what was deleted, by whom, and why.
 *
 * A deleted request is never removed from the database — it leaves the working lists and
 * lands here, so a request that vanished from the queue can always be accounted for.
 */
function DeletedRequestsTable({ rows }: { rows: DeletedPoRequest[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="table-panel">
      <div className="table-meta">
        <h3>
          Deleted requests <HeaderInfo label="Deleted requests" />
        </h3>
        <div className="wf-issue-row">
          <span>{rows.length} deleted</span>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />} {open ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {open && (
        <div className="table-scroll">
          <table className="wide-table wf-po-table">
            <thead>
              <tr>
                <th>Request <HeaderInfo label="Request" /></th>
                <th>Product <HeaderInfo label="Product" /></th>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th className="num">Qty <HeaderInfo label="Qty" /></th>
                <th>Was <HeaderInfo label="Was" /></th>
                <th>Raised by <HeaderInfo label="Raised by" /></th>
                <th>Deleted by <HeaderInfo label="Deleted by" /></th>
                <th>Reason <HeaderInfo label="Reason" /></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.request_id}</td>
                  <td className="mono">{r.product_code ?? '—'}</td>
                  <td>
                    {r.vendor_code && r.vendor_name
                      ? `${r.vendor_code.toUpperCase()} - ${r.vendor_name}`
                      : r.vendor_name || r.vendor_code || '—'}
                  </td>
                  <td className="num">{nfmt(Number(r.po_qty || 0))}</td>
                  <td>
                    <span className="wf-status">{STATUS_LABEL[r.status]}</span>
                  </td>
                  <td>
                    {r.created_by ?? '—'}
                    <small className="wf-subtle">raised {stamp(r.timestamp_created)}</small>
                  </td>
                  <td>
                    {r.deleted_by ?? '—'}
                    {/* Whoever deleted it is not always whoever raised it — an admin may. */}
                    <small className="wf-subtle">{stamp(r.deleted_at)}</small>
                  </td>
                  <td>{r.delete_reason ?? '—'}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={8} className="wf-empty-cell">
                    Nothing has been deleted.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * PO submission / closure — the open (issued) POs below the main table, SKU-wise
 * expandable, with a simple row-wise Yes/No closure.
 */
function PoSubmissionTable({
  submissions,
  editable,
}: {
  submissions: PoSubmissionGroup[];
  editable: boolean;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const shown = submissions.filter((s) =>
    q
      ? `${s.po_number} ${s.po_ref_num ?? ''} ${s.vendor_name ?? ''} ${s.product_codes.join(' ')}`
          .toLowerCase()
          .includes(q.trim().toLowerCase())
      : true,
  );

  function decide(po_number: string, decision: 'yes' | 'no') {
    const fd = new FormData();
    fd.set('po_number', po_number);
    fd.set('decision', decision);
    start(async () => {
      const res = await setPoClosure(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
    });
  }

  return (
    <div className="panel">
      <div className="panel-title">
        <h3>
          PO submission &amp; closure
          <InfoDot text={"WHAT: every issued PO that is still open.\n\nHOW: issued POs whose delivery is not yet complete.\n\nUSE: mark rows submitted as they progress and close them out once delivery completes, so they stop counting as open everywhere else."} />
        </h3>
        <span>{submissions.length} open PO(s) · row-wise close</span>
      </div>
      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter PO / vendor / product…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="table-panel">
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th />
                <th>PO <HeaderInfo label="PO" /></th>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Products <HeaderInfo label="Products" /></th>
                <th className="num">Ordered <HeaderInfo label="Ordered" /></th>
                <th className="num">Pending <HeaderInfo label="Pending" /></th>
                <th>EDD <HeaderInfo label="EDD" /></th>
                <th>Closure <HeaderInfo label="Closure" /></th>
                {editable && <th aria-label="Decide" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => (
                <Fragment key={s.po_number}>
                  <tr className={open === s.po_number ? 'wf-row-open' : ''}>
                    <td>
                      <button
                        type="button"
                        className="wf-expand-btn"
                        aria-expanded={open === s.po_number}
                        aria-label="SKU breakdown"
                        onClick={() => setOpen(open === s.po_number ? null : s.po_number)}
                      >
                        {open === s.po_number ? '−' : '+'}
                      </button>
                    </td>
                    <td className="mono">
                      {s.po_number}
                      <small className="wf-subtle">{s.po_ref_num}</small>
                    </td>
                    <td>
                      {s.vendor_code && s.vendor_name
                        ? `${s.vendor_code.toUpperCase()} - ${s.vendor_name}`
                        : s.vendor_name || s.vendor_code || '—'}
                    </td>
                    <td className="mono">{s.product_codes.join(', ') || '—'}</td>
                    <td className="num">{nfmt(s.original_qty)}</td>
                    <td className="num strong">{nfmt(s.pending_qty)}</td>
                    <td className="wf-subtle">{s.expected_delivery_date ?? '—'}</td>
                    <td>
                      <StatusBadge status={s.closureStatus} />
                    </td>
                    {editable && (
                      <td>
                        <div className="wf-issue-row">
                          <button
                            type="button"
                            className="wf-btn wf-btn-ghost wf-btn-sm"
                            disabled={busy || s.closureStatus === 'approved'}
                            title="Close this PO"
                            onClick={() => decide(s.po_number, 'yes')}
                          >
                            <CheckCircle size={14} /> Yes
                          </button>
                          <button
                            type="button"
                            className="wf-btn wf-btn-ghost wf-btn-sm"
                            disabled={busy || s.closureStatus === 'rejected'}
                            title="Flag this PO"
                            onClick={() => decide(s.po_number, 'no')}
                          >
                            <X size={14} /> No
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {open === s.po_number && (
                    <tr className="wf-po-sku-row">
                      <td colSpan={editable ? 9 : 8}>
                        <table className="wf-grid wf-cost-lines">
                          <thead>
                            <tr>
                              <th>SKU <HeaderInfo label="SKU" /></th>
                              <th>Variant <HeaderInfo label="Variant" /></th>
                              <th>Size <HeaderInfo label="Size" /></th>
                              <th className="num">Ordered <HeaderInfo label="Ordered" /></th>
                              <th className="num">Pending <HeaderInfo label="Pending" /></th>
                              <th className="num">Price <HeaderInfo label="Price" /></th>
                              <th>EDD <HeaderInfo label="EDD" /></th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.lines.map((l, i) => (
                              <tr key={`${l.sku}-${i}`}>
                                <td className="mono">{l.sku ?? '—'}</td>
                                <td>{l.product_variant ?? '—'}</td>
                                <td>{l.size ?? '—'}</td>
                                <td className="num">{nfmt(l.original_qty)}</td>
                                <td className="num">{nfmt(l.pending_qty)}</td>
                                <td className="num">{l.item_price ?? '—'}</td>
                                <td className="wf-subtle">{l.expected_delivery_date ?? '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={editable ? 9 : 8} className="wf-empty-cell">
                    No open POs{submissions.length ? ' match your filter.' : ' (loads from the PO pipeline).'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Standard TNA lead-times — documented once, drives the critical-path auto-generate. */
function TnaLeadtimesPanel({ leadtimes }: { leadtimes: TnaLeadtimes }) {
  const [d, setD] = useState({
    pp_sample_days: leadtimes.pp_sample_days?.toString() ?? '',
    gpt_days: leadtimes.gpt_days?.toString() ?? '',
    cutting_days: leadtimes.cutting_days?.toString() ?? '',
    inline_qc_days: leadtimes.inline_qc_days?.toString() ?? '',
    first_delivery_days: leadtimes.first_delivery_days?.toString() ?? '',
    po_closing_days: leadtimes.po_closing_days?.toString() ?? '',
  });
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof d, v: string) => setD((c) => ({ ...c, [k]: v }));

  function save() {
    const fd = new FormData();
    Object.entries(d).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await saveTnaLeadtimes(fd);
      setMsg(res.ok ? 'Saved.' : res.error);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
    });
  }

  const FIELDS: [keyof typeof d, string][] = [
    ['pp_sample_days', 'PP sample (+days)'],
    ['gpt_days', 'GPT (+days)'],
    ['cutting_days', 'Cutting (+days)'],
    ['inline_qc_days', 'Inline QC (+days)'],
    ['first_delivery_days', 'First delivery (+days)'],
    ['po_closing_days', 'PO closing (+days)'],
  ];

  return (
    <details className="wf-standards-panel">
      <summary>TNA lead-times — documented once, auto-generates the critical path</summary>
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="wf-form-grid">
        {FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <input type="number" min={0} value={d[k]} onChange={(e) => set(k, e.target.value)} />
          </Field>
        ))}
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
          <Save size={13} /> {busy ? 'Saving…' : 'Save lead-times'}
        </button>
      </div>
    </details>
  );
}
