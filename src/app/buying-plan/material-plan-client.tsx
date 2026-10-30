'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import { ClipboardList, Download, Eye, Plus, Save, Send, Trash2, Upload } from 'lucide-react';
import { saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import {
  canApprove,
  canEdit,
  canSubmitPlan,
  isPlanFrozen,
  isPlanWindowOpen,
  monthLabel,
} from '@/lib/forms/approval';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { Notice } from '@/components/forms/form-layout';
import { Combobox } from '@/components/forms/combobox';
import { materialDraftRows } from '@/lib/material-plan-draft';
import { InfoDot } from '@/components/info-dot';
import { statusText } from '@/lib/forms/approval';
import { PlanHeader, planFacts, planStatusWord, type PlanMonthStatus } from './plan-header';
import { MAT_KANBAN, MaterialPlanView, toMaterialCard } from './material-plan-view';
import { PlanLineViews, type KanbanOption } from './plan-line-views';
import { BulkDecisionBar, LineDecision, lineIdOf, type LineEdits } from './line-decision';
import type {
  BuyingPlan,
  BuyingPlanLine,
  MaterialCode,
  MaterialType,
  SdRole,
  SdStatus,
} from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (v: string) => Number(v) || 0;
const UOMS = ['metres', 'kg', 'pcs', 'rolls', 'sets'];

const TYPES: { key: MaterialType; label: string }[] = [
  { key: 'raw', label: 'Raw material' },
  { key: 'dyed', label: 'Dyed / finished' },
  { key: 'trim', label: 'Trims' },
];
const TYPE_LABEL: Record<MaterialType, string> = {
  raw: 'Raw material',
  dyed: 'Dyed / finished',
  trim: 'Trim',
};

type Row = {
  key: string;
  material_code: string;
  material_type: MaterialType;
  colour: string; // editable per-line colour (Dyed lines); defaults to the code's master colour
  job_qty: string; // Job Work (e.g. paying for dyeing) quantity
  purchase_qty: string; // Purchase / FOB (buying outright) quantity
  uom: string;
  remark: string;
  /** Value frozen at submission (server-owned; carried through so the view can show it). */
  standard_value: string;
  /** Per-line approval state (server-owned, read-only here). */
  line_status: SdStatus | null;
  auto_approved?: boolean;
  approver_edited: boolean;
};

const EMPTY_MATERIAL_ENTRY = { colour: '', job_qty: '', purchase_qty: '', uom: 'metres', remark: '' };

// Legacy material lines predate material_type — treat them as raw.
function asType(v: string | null): MaterialType {
  return v === 'dyed' || v === 'trim' ? v : 'raw';
}

function toRow(l: BuyingPlanLine): Row {
  return {
    key: `line-${l.id}`,
    material_code: l.product_code,
    material_type: asType(l.material_type),
    colour: l.colour ?? '',
    job_qty: l.job_work_qty?.toString() ?? '',
    purchase_qty: l.fob_qty?.toString() ?? '',
    uom: l.uom ?? 'metres',
    remark: l.remark ?? '',
    standard_value: l.standard_value?.toString() ?? '',
    line_status: l.line_status ?? null,
    approver_edited: Boolean(l.approver_edited),
    auto_approved: Boolean(l.auto_approved),
  };
}

// Fill the plan kanban: entry checks first, then the Plan detail options.
const MAT_INPUT_KANBAN: KanbanOption[] = [
  {
    key: 'validation',
    label: 'Check',
    columns: [
      { key: 'noqty', title: 'No quantity yet', tone: 'gray' },
      { key: 'nocost', title: 'No approved cost', tone: 'red' },
      { key: 'ready', title: 'Ready', tone: 'green' },
    ],
  },
  ...MAT_KANBAN.filter((k) => k.key !== 'type').map((k) =>
    k.key === 'route' && k.columns ? { ...k, columns: [{ key: 'noqty', title: 'No quantity yet', tone: 'gray' as const }, ...k.columns] } : k,
  ),
];

function poTypeToField(value: string): 'job' | 'purchase' | null {
  const n = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (n === 'job' || n === 'jobwork') return 'job';
  if (n === 'purchase' || n === 'fob' || n === 'buy') return 'purchase';
  return null;
}

export function MaterialPlanClient({
  planMonth,
  plan,
  lines,
  materialCodes,
  materialCosts,
  role,
  startInInput = false,
  planMonths = [],
  afterHeader = null,
}: {
  planMonth: string;
  /** Every month's status on both tracks, for the header's month picker and tab dots. */
  planMonths?: PlanMonthStatus[];
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  materialCodes: MaterialCode[];
  colours: string[];
  materialCosts: Record<string, { job: number; fob: number }>;
  role: SdRole;
  /** Open on the Input view (and scroll to it) - set by ?mode=input. */
  startInInput?: boolean;
  /** Under the header: the Variation Report on a month that is over. */
  afterHeader?: React.ReactNode;
}) {
  const status: SdStatus = plan?.status ?? 'draft';
  // Submitted / awaiting approval / approved: values are frozen at submission.
  const planLocked = status === 'submitted' || status === 'pending_l2' || status === 'approved';
  // A month that is over is VIEW ONLY (user rule, 2026-10-08) — same as the FG track.
  const frozen = isPlanFrozen(planMonth);
  const editable = canEdit(role, status) && !frozen;
  // Per-line decision for the approver, next to the plan-wide decision card.
  const canDecideLines =
    Boolean(plan?.id) && !frozen && (status === 'submitted' || status === 'pending_l2') && canApprove(role, status);
  // Quantities the approver changed on screen (Job Work → job_work_qty, Purchase → fob_qty).
  const savedByKey = new Map(lines.map((l) => [`line-${l.id}`, l]));
  const editsFor = (key: string): LineEdits | null => {
    const saved = savedByKey.get(key);
    const row = rows.find((r) => r.key === key);
    if (!saved || !row) return null;
    const out: LineEdits = {};
    if (num(row.job_qty) !== (Number(saved.job_work_qty) || 0)) out.job_work_qty = num(row.job_qty);
    if (num(row.purchase_qty) !== (Number(saved.fob_qty) || 0)) out.fob_qty = num(row.purchase_qty);
    return Object.keys(out).length ? out : null;
  };
  const decisionCell = (row: Row) =>
    plan?.id ? (
      <LineDecision
        planId={plan.id}
        lineKey={row.key}
        lineStatus={row.line_status}
        autoApproved={row.auto_approved} approverEdited={row.approver_edited}
        label={row.material_code}
        entityLabel={`Material plan ${planMonth.slice(0, 7)}`}
        edits={editsFor(row.key)}
      />
    ) : null;
  const [rows, setRows] = useState<Row[]>(() => lines.map(toRow));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<'view' | 'input'>(startInInput && !frozen ? 'input' : 'view');
  // Opened from the month board's Start / Edit plan (?mode=input): bring the input area into view.
  const modeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (startInInput) modeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [startInInput]);
  const [type, setType] = useState<MaterialType>('raw');
  const [addCode, setAddCode] = useState('');
  const [newEntry, setNewEntry] = useState({ ...EMPTY_MATERIAL_ENTRY });
  const setEntry = (field: keyof typeof EMPTY_MATERIAL_ENTRY, value: string) =>
    setNewEntry((current) => ({ ...current, [field]: value }));
  const entryCost = materialCosts[addCode];
  const entryValue = num(newEntry.job_qty) * (entryCost?.job ?? 0) + num(newEntry.purchase_qty) * (entryCost?.fob ?? 0);
  const entryMissingCost = (num(newEntry.job_qty) > 0 && !entryCost?.job) || (num(newEntry.purchase_qty) > 0 && !entryCost?.fob);
  const fileRef = useRef<HTMLInputElement>(null);

  const codeMap = useMemo(
    () => new Map(materialCodes.map((c) => [c.material_code, c])),
    [materialCodes],
  );

  // Rates now come from the approved Material Standard Cost (job = Job Work,
  // fob = Purchase). A planned line with no approved cost is flagged, not blocked.
  const view = rows.map((r) => {
    const cost = materialCosts[r.material_code];
    const jobQty = num(r.job_qty);
    const purchaseQty = num(r.purchase_qty);
    const totalQty = jobQty + purchaseQty;
    // Same rule as the FG track: live latest-accepted rate while editing; once
    // submitted, the value frozen at submission (standard_value) is shown verbatim.
    const storedValue = r.standard_value ? Number(r.standard_value) : 0;
    // A line the approver is editing is valued live, as it will be re-priced on approval.
    const useStored = storedValue > 0 && (planLocked || !cost) && !(planLocked && editsFor(r.key));
    const jobValue = useStored
      ? (totalQty ? (storedValue * jobQty) / totalQty : 0)
      : jobQty * (cost?.job ?? 0);
    const purchaseValue = useStored
      ? (totalQty ? (storedValue * purchaseQty) / totalQty : 0)
      : purchaseQty * (cost?.fob ?? 0);
    const rateMissing = !cost || (jobQty > 0 && !cost.job) || (purchaseQty > 0 && !cost.fob);
    return {
      row: r,
      cost: cost ?? null,
      jobValue,
      purchaseValue,
      value: jobValue + purchaseValue,
      missingCost: totalQty > 0 && !useStored && rateMissing,
      // Effective colour for display: the per-line pick, else the code's master colour.
      colour: (planLocked || frozen ? r.colour || codeMap.get(r.material_code)?.colour : codeMap.get(r.material_code)?.colour ?? r.colour) || null,
    };
  });
  const hasEntry = Boolean(addCode && !rows.some((row) => row.material_code === addCode));
  const totals = view.reduce(
    (a, v) => ({ job: a.job + v.jobValue, purchase: a.purchase + v.purchaseValue }),
    { job: hasEntry ? num(newEntry.job_qty) * (entryCost?.job ?? 0) : 0, purchase: hasEntry ? num(newEntry.purchase_qty) * (entryCost?.fob ?? 0) : 0 },
  );
  const grandTotal = totals.job + totals.purchase;
  const plannedLines = rows.filter((r) => num(r.job_qty) + num(r.purchase_qty) > 0).length + (hasEntry && num(newEntry.job_qty) + num(newEntry.purchase_qty) > 0 ? 1 : 0);
  const missingCostLines = view.filter((v) => v.missingCost).length + (hasEntry && entryMissingCost ? 1 : 0);

  // Codes for the active type not already added — for the "Add code" picker.
  const usedCodes = new Set(rows.map((r) => r.material_code));
  const available = materialCodes.filter(
    (c) => c.material_type === type && !usedCodes.has(c.material_code),
  );
  const codeChoices = available;
  const shownRows = view.filter((v) => v.row.material_type === type);

  // Approver: tick several material lines and decide them together.
  const bulkDecide = canDecideLines && plan?.id
    ? {
        pickable: (key: string) => {
          const r = rows.find((x) => x.key === key);
          return Boolean(r && lineIdOf(key) && num(r.job_qty) + num(r.purchase_qty) > 0 && !['approved', 'rejected', 'rework'].includes(r.line_status ?? ''));
        },
        bar: (keys: string[], clear: () => void) => (
          <BulkDecisionBar
            planId={plan.id}
            entityLabel={`Material plan ${planMonth.slice(0, 7)}`}
            keys={keys}
            editsFor={editsFor}
            value={money.format(view.filter((v) => keys.includes(v.row.key)).reduce((t, v) => t + (v.missingCost ? 0 : v.value), 0))}
            onClear={clear}
          />
        ),
      }
    : undefined;

  // Fill the plan on a card: the same fields and handlers as the Input table.
  const inputEditor = (key: string) => {
    const row = rows.find((r) => r.key === key);
    if (!row) return null;
    const cost = materialCosts[row.material_code];
    const unit = row.uom || 'unit';
    return (
      <>
        <label>
          Job Work
          <input type="number" min={0} value={row.job_qty} disabled={!editable || pending} onChange={(e) => set(row.key, 'job_qty', e.target.value)} />
          <small title="Approved Job rate per unit">{cost?.job ? `@ ₹${fmt.format(cost.job)} / ${unit}` : 'no rate'}</small>
        </label>
        <label>
          Purchase
          <input type="number" min={0} value={row.purchase_qty} disabled={!editable || pending} onChange={(e) => set(row.key, 'purchase_qty', e.target.value)} />
          <small title="Approved Purchase rate per unit">{cost?.fob ? `@ ₹${fmt.format(cost.fob)} / ${unit}` : 'no rate'}</small>
        </label>
        <label>
          UOM
          <select value={row.uom} disabled={!editable || pending} onChange={(e) => set(row.key, 'uom', e.target.value)}>
            {UOMS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        {row.material_type === 'dyed' && (
          <label className="wide">
            Colour
            <input readOnly value={codeMap.get(row.material_code)?.colour ?? row.colour} placeholder="Not set on material code" />
          </label>
        )}
        <label className="wide">
          Remark
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={row.remark} disabled={!editable || pending} placeholder="optional" onChange={(e) => set(row.key, 'remark', e.target.value)} style={{ fontWeight: 400 }} />
            {editable && (
              <button type="button" className="pl-card-remove" aria-label={`Remove ${row.material_code}`} onClick={() => setRows((cur) => cur.filter((r) => r.key !== row.key))}>
                <Trash2 size={14} />
              </button>
            )}
          </span>
        </label>
      </>
    );
  };

  const set = (key: string, field: keyof Row, value: string) =>
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, [field]: value } : r)));

  function pendingMaterialRow(): Row | null {
    if (!addCode) return null;
    const meta = codeMap.get(addCode);
    if (!meta || meta.material_type !== type) throw new Error('Select an available material code.');
    return {
      key: `new-${addCode}-${Date.now()}`,
      material_code: addCode,
      material_type: meta.material_type,
      ...newEntry,
      colour: meta.colour ?? '',
      standard_value: '',
      line_status: null,
      approver_edited: false,
    };
  }

  function addRow(code: string) {
    if (!editable || pending || !codeChoices.some((choice) => choice.material_code === code)) return;
    try {
      setRows(materialDraftRows(rows, pendingMaterialRow()));
      setAddCode('');
      setNewEntry({ ...EMPTY_MATERIAL_ENTRY });
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not add the material row.');
    }
  }

  // Export = every line of the plan as entered (used by the closed-month header).
  function exportCsv() {
    downloadCsv(
      `material-buying-plan-${planMonth.slice(0, 7)}.csv`,
      ['material_type', 'material_code', 'colour', 'job_qty', 'purchase_qty', 'uom', 'value', 'remark'],
      view.map((v) => [
        v.row.material_type,
        v.row.material_code,
        v.colour ?? '',
        v.row.job_qty,
        v.row.purchase_qty,
        v.row.uom,
        String(Math.round(v.value)),
        v.row.remark,
      ]),
    );
  }

  function downloadTemplate() {
    const examples = materialCodes.slice(0, 2).map((c) => [
      c.material_type,
      c.material_code,
      c.material_type === 'trim' ? 'purchase' : 'job',
      '100',
      '',
    ]);
    downloadCsv(
      'material-buying-plan-template.csv',
      ['material_type', 'material_code', 'po_type', 'quantity', 'remark'],
      examples,
    );
  }

  async function onCsvFile(file: File) {
    setError(null);
    setMessage(null);
    let objects: Record<string, string>[];
    try {
      objects = csvObjects(await file.text());
    } catch {
      setError('Could not read that file as CSV.');
      return;
    }
    const acc = new Map<string, { job: number; purchase: number; remark: string }>();
    const skipped: string[] = [];
    objects.forEach((r, i) => {
      const line = i + 2;
      const code = String(r.material_code ?? '').trim().toUpperCase();
      const field = poTypeToField(String(r.po_type ?? ''));
      const qty = Number(r.quantity);
      if (!code) return skipped.push(`row ${line}: missing material code`);
      if (!codeMap.has(code)) return skipped.push(`row ${line}: unknown code "${code}"`);
      if (!field) return skipped.push(`row ${line}: unknown po_type "${r.po_type ?? ''}"`);
      if (!Number.isFinite(qty) || qty <= 0) return skipped.push(`row ${line}: non-positive quantity`);
      const cur = acc.get(code) ?? { job: 0, purchase: 0, remark: '' };
      cur[field] += qty;
      if (r.remark) cur.remark = String(r.remark);
      acc.set(code, cur);
    });

    if (!acc.size) {
      setError(
        `No valid rows imported.${skipped.length ? ` ${skipped.slice(0, 5).join('; ')}` : ' Expected headers: material_code, po_type, quantity.'}`,
      );
      return;
    }

    setRows((cur) => {
      const map = new Map(cur.map((r) => [r.material_code, r] as const));
      let seq = 0;
      for (const [code, q] of acc) {
        const meta = codeMap.get(code);
        const base: Row = map.get(code) ?? {
          key: `csv-${code}-${seq++}`,
          material_code: code,
          material_type: (meta?.material_type as MaterialType) ?? 'raw',
          colour: meta?.colour ?? '',
          job_qty: '',
          purchase_qty: '',
          uom: meta?.material_type === 'trim' ? 'pcs' : 'metres',
          remark: '',
          standard_value: '',
          line_status: null,
          approver_edited: false,
        };
        map.set(code, {
          ...base,
          job_qty: q.job ? String(q.job) : base.job_qty,
          purchase_qty: q.purchase ? String(q.purchase) : base.purchase_qty,
          remark: q.remark || base.remark,
        });
      }
      return [...map.values()];
    });
    setMessage(
      `Imported ${acc.size} material(s).` +
        (skipped.length
          ? ` Skipped ${skipped.length} row(s): ${skipped.slice(0, 6).join('; ')}${skipped.length > 6 ? '…' : ''}`
          : ''),
    );
  }

  function save() {
    setError(null);
    setMessage(null);
    if (!editable || pending) return;
    if (!addCode && (newEntry.job_qty || newEntry.purchase_qty || newEntry.remark || newEntry.colour)) {
      setError('Select a material code for the row you entered before saving.');
      return;
    }
    let rowsToSave: Row[];
    try {
      rowsToSave = materialDraftRows(rows, pendingMaterialRow());
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not prepare the material rows.');
      return;
    }
    const snapshot = rowsToSave
      .filter((r) => r.material_code.trim())
      .map((r) => ({
        product_code: r.material_code.trim(),
        material_type: r.material_type,
        colour: r.material_type === 'dyed' ? codeMap.get(r.material_code)?.colour ?? r.colour : '',
        job_work_qty: r.job_qty,
        fob_qty: r.purchase_qty,
        uom: r.uom,
        remark: r.remark,
      }));
    const payload = new FormData();
    payload.set('plan_month', planMonth);
    payload.set('plan_type', 'material');
    payload.set('lines', JSON.stringify(snapshot));
    start(async () => {
      try {
        const result = await saveBuyingPlan(payload);
        if (result.ok) {
          setRows(rowsToSave);
          setAddCode('');
          setNewEntry({ ...EMPTY_MATERIAL_ENTRY });
          // Reload the IDs and approval state returned by the saved plan.
          reloadWithToast(result.message ?? 'Saved.');
        } else setError(toastError(result.error));
      } catch (error) {
        setError(toastError(error instanceof Error ? error.message : 'Could not save the plan. Please try again.'));
      }
    });
  }

  function submit() {
    if (!plan?.id) {
      setError('Save the plan before submitting it.');
      return;
    }
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('plan_id', String(plan.id));
    start(async () => {
      const result = await submitBuyingPlan(payload);
      if (result.ok) setMessage(result.message ?? 'Submitted.');
      else setError(toastError(result.error));
    });
  }

  return (
    <>
      <div className={`bp-material-workspace${mode === 'input' ? ' is-input' : ''}`}>
      {/* Same header as every Buying Plan tab (plan-header.tsx). */}
      <PlanHeader
        planMonth={planMonth}
        planType="material"
        months={planMonths}
        status={(() => {
          const w = planStatusWord(plan ? status : null, frozen);
          return status === 'approved' ? { tone: w.tone, text: statusText(status, { edited: plan?.edited_before_approval, autoApproved: plan?.auto_approved, approverEdited: plan?.approver_edited }) } : w;
        })()}
        facts={planFacts(
          planMonth,
          plan ? { status, submitted_at: plan.submitted_at ?? null, decided_at: plan.approved_at ?? null } : null,
        )}
        actions={
          <>
            <button type="button" className="wf-btn wf-btn-ghost" onClick={exportCsv} disabled={!view.length}>
              <Download size={15} /> Export
            </button>

          </>
        }
        modeControl={
          frozen ? null : (
            <div className="segment wf-segment bph-mode" ref={modeRef} style={{ scrollMarginTop: 96 }}>
              <button type="button" className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
                <Eye size={14} /> View
              </button>
              <button type="button" className={mode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>
                <ClipboardList size={14} /> Input
              </button>
            </div>
          )
        }
      />
      {afterHeader}

      {!isPlanWindowOpen(planMonth) && (
        <p className="bp-material-window-note">
          Note: The window for {monthLabel(planMonth)} opens seven days before the month starts. You can
          still draft ahead.
        </p>
      )}



      {!editable && !frozen && mode === 'input' && (
        <Notice tone="warn">
          This month’s plan is {status === 'approved' ? 'approved and locked' : 'read-only'}. Pick
          another month above to draft a new plan.
        </Notice>
      )}

      {plan?.rejection_notes && status === 'rejected' && (
        <Notice tone="error">
          <strong>Rejected / Discarded.</strong> {plan.rejection_notes}
        </Notice>
      )}
      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {mode === 'view' && (
        <MaterialPlanView
          view={view}
          codeMap={codeMap}
          planLocked={planLocked}
          status={status}
          closedOn={frozen ? planMonth : null}
          onEdit={editable ? () => setMode('input') : undefined}
        />
      )}

      {mode === 'input' && (
          <section className="bp-card bp-material-editor">
            <div className="bp-cardhead">
              <div>
                <h2>
                  Bulk Upload or Manually Enter Buying Plan
                  <InfoDot text={"WHAT: where this month's material quantities are typed in.\n\nHOW: per material code, quantity as Job Work or Purchase; value = quantity × the approved Material Standard Cost for that route.\n\nUSE: a material with no approved cost shows no value — get it approved on Standard Cost (Material track) first."} />
                </h2>
                <span className="wf-subtle">Please fill the Buying Plan for raw material, finished/dyed fabric and trims.</span>
              </div>
            </div>
            {editable && (
              <div className="bph-inputbar-actions bp-material-input-actions">
                <strong className="bp-material-input-label">Import Buying Plan</strong>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".csv,text/csv"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void onCsvFile(file);
                    event.target.value = '';
                  }}
                />
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadTemplate}>
                  <Download size={14} /> Download Plan Template
                </button>
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => fileRef.current?.click()} disabled={pending}>
                  <Upload size={14} /> Import Plan CSV
                </button>

              </div>
            )}
            <div className="bp-toolbar-card bp-material-input-toolbar">
              <div className="bp-toolbar bp-mat-toolbar">
                <span className="bp-material-input-or">Or</span>
                <strong className="bp-material-input-label">Add Buying Plan Manually</strong>
        <div className="segment wf-segment bp-material-type-tabs">
          {TYPES.map((t) => {
            const count = rows.filter((r) => r.material_type === t.key).length;
            return (
              <button
                key={t.key}
                type="button"
                className={type === t.key ? 'active' : ''}
                disabled={pending}
                onClick={() => { setType(t.key); setAddCode(''); setNewEntry({ ...EMPTY_MATERIAL_ENTRY }); }}
              >
                {t.label}
                {count > 0 && <span className="wf-seg-count">{count}</span>}
              </button>
            );
          })}
        </div>

              </div>
            </div>
            <div className="bp-cardbody bp-cardbody-flush">
          <PlanLineViews
            tableOnly
            items={shownRows.map((v) => {
              // Every input-table column on the card: rates and values per route, total, check.
              const base = toMaterialCard(v, { codeMap, status, total: grandTotal });
              const qty = num(v.row.job_qty) + num(v.row.purchase_qty);
              return {
                ...base,
                check: !qty
                  ? { text: 'No qty', tone: 'gray' as const }
                  : v.missingCost
                    ? { text: 'No approved cost', tone: 'red' as const }
                    : { text: 'Ready', tone: 'green' as const },
                rates: '',
                info: [
                  ['Job Work value', v.jobValue ? money.format(v.jobValue) : '—'],
                  ['Purchase value', v.purchaseValue ? money.format(v.purchaseValue) : '—'],
                  ['Base fabric', codeMap.get(v.row.material_code)?.base_fabric_code ?? '—'],
                  ['Total value', v.missingCost ? 'No approved cost' : money.format(v.value)],
                ] as [string, string][],
              };
            })}
            storageKey="material-plan-input-view"
            bulk={bulkDecide}
            noun="material line"
            qtyUnit={null}
            kanban={MAT_INPUT_KANBAN}
            editor={inputEditor}
            decision={canDecideLines ? (key) => {
              const r = rows.find((x) => x.key === key);
              return r && num(r.job_qty) + num(r.purchase_qty) > 0 ? decisionCell(r) : null;
            } : undefined}
            table={
              <div className="table-panel wf-grid-panel">
                <div className="table-scroll">
                  <table className="wide-table wf-grid bp-material-input-grid" style={{ width: '100%', minWidth: 990 + (type === 'dyed' ? 120 : 0) + (canDecideLines ? 160 : 0) + (editable ? 40 : 0) }}>
                    <colgroup>
                      <col style={{ width: 220 }} />
                      {type === 'dyed' && <col style={{ width: 120 }} />}
                      <col style={{ width: 100 }} />
                      <col style={{ width: 80 }} />
                      <col style={{ width: 110 }} />
                      <col style={{ width: 110 }} />
                      <col style={{ width: 80 }} />
                      <col style={{ width: 140 }} />
                      <col style={{ width: 150 }} />
                      {canDecideLines && <col style={{ width: 160 }} />}
                      {editable && <col style={{ width: 40 }} />}
                    </colgroup>
                    <thead>
                      <tr>
                        <th>
                          {TYPE_LABEL[type]} code
                          <InfoDot
                            label="About material plan input"
                            text={"WHAT: where this month's material quantities are typed in.\n\nHOW: per material code, quantity as Job Work or Purchase; value = quantity × the approved Material Standard Cost for that route.\n\nUSE: a material with no approved cost shows no value — get it approved on Standard Cost (Material track) first."}
                          />
                        </th>
                        {type === 'dyed' && <th className="input-col wf-cell-input">Colour <HeaderInfo label="Colour" /></th>}
                        <th className="num input-col wf-cell-input">Job Work qty <HeaderInfo label="Job Work qty" /></th>
                        <th className="num wf-cell-calc">Job rate <HeaderInfo label="Job rate" /></th>
                        <th className="num input-col wf-cell-input">Purchase qty <HeaderInfo label="Purchase qty" /></th>
                        <th className="num wf-cell-calc">Purchase rate <HeaderInfo label="Purchase rate" /></th>
                        <th className="input-col wf-cell-input">UOM <HeaderInfo label="UOM" /></th>
                        <th className="input-col wf-cell-input">Remark <HeaderInfo label="Remark" /></th>
                        <th className="num wf-cell-calc">Value <HeaderInfo label="Value" /></th>
                        {canDecideLines && <th>Your decision</th>}
                        {editable && <th aria-label="Remove" />}
                      </tr>
                    </thead>
                    <tbody>
                      {shownRows.map(({ row, value, cost, missingCost }) => (
                        <tr key={row.key}>
                          <td className="mono">{row.material_code}</td>
                          {type === 'dyed' && (
                            <td className="input-col wf-cell-input">
                              <input aria-label={`Colour for ${row.material_code}`} readOnly value={(planLocked || frozen ? row.colour || codeMap.get(row.material_code)?.colour : codeMap.get(row.material_code)?.colour ?? row.colour) ?? ''} placeholder="Not set on material code" />
                            </td>
                          )}
                          <td className="num input-col wf-cell-input">
                            <input type="number" min={0} value={row.job_qty} disabled={!editable || pending} onChange={(e) => set(row.key, 'job_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{cost ? fmt.format(cost.job) : '—'}</td>
                          <td className="num input-col wf-cell-input">
                            <input type="number" min={0} value={row.purchase_qty} disabled={!editable || pending} onChange={(e) => set(row.key, 'purchase_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{cost ? fmt.format(cost.fob) : '—'}</td>
                          <td className="input-col wf-cell-input">
                            <select value={row.uom} disabled={!editable || pending} onChange={(e) => set(row.key, 'uom', e.target.value)}>
                              {UOMS.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="input-col wf-cell-input">
                            <input value={row.remark} disabled={!editable || pending} placeholder="optional" onChange={(e) => set(row.key, 'remark', e.target.value)} />
                          </td>
                          <td className="num strong wf-cell-calc">
                            {missingCost ? <span className="wf-over-tag">no approved cost</span> : money.format(value)}
                          </td>
                          {canDecideLines && <td>{num(row.job_qty) + num(row.purchase_qty) > 0 ? decisionCell(row) : <span className="wf-subtle">—</span>}</td>}
                          {editable && (
                            <td>
                              <button type="button" className="wf-icon-btn" aria-label={`Remove ${row.material_code}`} disabled={pending} onClick={() => setRows((cur) => cur.filter((r) => r.key !== row.key))}>
                                <Trash2 size={14} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {editable && (
                        <tr>
                          <td className="input-col wf-cell-input">
          <div className="bp-mat-add">
            <Combobox
              key={type}
              value={addCode}
              onChange={(code) => { setAddCode(code); setEntry('colour', codeMap.get(code)?.colour ?? ''); }}
              options={codeChoices.map((code) => ({
                value: code.material_code,
                label: code.material_code,
                detail: [code.fabric_name, code.colour].filter(Boolean).join(' / '),
              }))}
              allowFreeText={false}
              disabled={pending || !codeChoices.length}
              ariaLabel="Search material code"
              placeholder={codeChoices.length
                ? 'Search code, name or colour'
                : materialCodes.some((code) => code.material_type === type)
                  ? 'All codes added'
                  : `No ${TYPE_LABEL[type].toLowerCase()} codes available`}
              emptyText="No matching material codes."
              limit={codeChoices.length}
            />

          </div>
                          </td>
                          {type === 'dyed' && (
                            <td className="input-col wf-cell-input">
                              <input aria-label="New material colour" readOnly value={codeMap.get(addCode)?.colour ?? ''} placeholder={addCode ? 'Not set on material code' : 'Select a material code'} />
                            </td>
                          )}
                          <td className="num input-col wf-cell-input">
                            <input aria-label="New material Job Work quantity" type="number" min={0} value={newEntry.job_qty} disabled={pending} onChange={(e) => setEntry('job_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{entryCost ? fmt.format(entryCost.job) : '—'}</td>
                          <td className="num input-col wf-cell-input">
                            <input aria-label="New material Purchase quantity" type="number" min={0} value={newEntry.purchase_qty} disabled={pending} onChange={(e) => setEntry('purchase_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{entryCost ? fmt.format(entryCost.fob) : '—'}</td>
                          <td className="input-col wf-cell-input">
                            <select aria-label="New material UOM" value={newEntry.uom} disabled={pending} onChange={(e) => setEntry('uom', e.target.value)}>
                              {UOMS.map((uom) => <option key={uom} value={uom}>{uom}</option>)}
                            </select>
                          </td>
                          <td className="input-col wf-cell-input">
                            <input aria-label="New material remark" value={newEntry.remark} disabled={pending} placeholder="optional" onChange={(e) => setEntry('remark', e.target.value)} />
                          </td>
                          <td className="num strong wf-cell-calc">
                            {!addCode ? '—' : entryMissingCost ? <span className="wf-over-tag">no approved cost</span> : money.format(entryValue)}
                          </td>
                          {canDecideLines && <td>—</td>}
                          <td>
                            <button type="button" className="wf-icon-btn" aria-label="Clear new material row" disabled={pending} onClick={() => { setAddCode(''); setNewEntry({ ...EMPTY_MATERIAL_ENTRY }); }}>
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      )}
                      {!shownRows.length && !editable && (
                        <tr>
                          <td colSpan={(type === 'dyed' ? 9 : 8) + (editable ? 1 : 0) + (canDecideLines ? 1 : 0)} className="wf-empty-cell">
                            No {TYPE_LABEL[type].toLowerCase()} lines yet
                            {editable ? ' — add a code above or import a CSV.' : '.'}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            }
          />
            </div>
            <div className="bp-material-add-row">
                {editable && (
            <button
              type="button"
              className="bp-material-add-link"
              onClick={() => addRow(addCode)}
              disabled={pending || !codeChoices.some((choice) => choice.material_code === addCode)}
            >
              <Plus size={14} /> Add material code row
            </button>
                )}
            </div>
          <div className="bp-metrics bp-input-metrics" aria-label="Material plan input summary">
            <div className="bp-metric">
              <div className="label">Lines in plan</div>
              <div className="value">{fmt.format(plannedLines)}</div>
              <div className="sub">{fmt.format(rows.length + (hasEntry ? 1 : 0))} material lines on sheet</div>
            </div>
            <div className="bp-metric">
              <div className="label">Job Work value</div>
              <div className="value">{totals.job ? money.format(totals.job) : '—'}</div>
              <div className="sub">services (e.g. dyeing)</div>
            </div>
            <div className="bp-metric">
              <div className="label">Purchase value</div>
              <div className="value">{totals.purchase ? money.format(totals.purchase) : '—'}</div>
              <div className="sub">material bought outright</div>
            </div>
            <div className="bp-metric">
              <div className="label">Review</div>
              <div className="value">{fmt.format(missingCostLines)}</div>
              <div className="sub">{missingCostLines ? `line${missingCostLines === 1 ? '' : 's'} with no approved material cost` : 'All planned lines have an approved cost'}</div>
            </div>
          </div>
            <div className="bp-input-footer">
              <div className="bp-actions">
              {editable && (
                <button type="button" className="wf-btn wf-btn-ghost" onClick={save} disabled={pending}>
                  <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
                </button>
              )}
              {canSubmitPlan(role, status) && !frozen && (
                <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !plan?.id}>
                  <Send size={15} /> Submit for approval
                </button>
              )}
              </div>
              <div className="bp-material-footer-summary">
                <strong>{grandTotal ? money.format(grandTotal) : 'value pending'}</strong>
                <span>Job Work {money.format(totals.job)} · Purchase {money.format(totals.purchase)} · {plannedLines} planned line{plannedLines === 1 ? '' : 's'}</span>
              </div>
            </div>
          </section>
      )}
      </div>


    </>
  );
}
