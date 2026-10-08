'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import { ClipboardList, Download, ExternalLink, Eye, Save, Send, Trash2, Upload } from 'lucide-react';
import { saveBuyingPlan, submitBuyingPlan } from '@/lib/forms/actions';
import {
  addMonths,
  canApprove,
  canEdit,
  canSubmit,
  isPlanFrozen,
  isPlanWindowOpen,
  monthLabel,
} from '@/lib/forms/approval';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { ClosedMonthHeader } from './closed-month-header';
import { MAT_KANBAN, MaterialPlanView, toMaterialCard } from './material-plan-view';
import { PlanLineViews, type KanbanOption } from './plan-line-views';
import { BulkDecisionBar, LineDecision, lineIdOf } from './line-decision';
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
  approver_edited: boolean;
};

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
  colours,
  materialCosts,
  role,
  startInInput = false,
}: {
  planMonth: string;
  plan: BuyingPlan | null;
  lines: BuyingPlanLine[];
  materialCodes: MaterialCode[];
  colours: string[];
  materialCosts: Record<string, { job: number; fob: number }>;
  role: SdRole;
  /** Open on the Input view (and scroll to it) - set by ?mode=input. */
  startInInput?: boolean;
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
  const decisionCell = (row: Row) =>
    plan?.id ? (
      <LineDecision
        planId={plan.id}
        lineKey={row.key}
        lineStatus={row.line_status}
        approverEdited={row.approver_edited}
        label={row.material_code}
        entityLabel={`Material plan ${planMonth.slice(0, 7)}`}
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
  const [addBase, setAddBase] = useState(''); // base-fabric filter in the add-material cascade
  const [addCode, setAddCode] = useState('');
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
    const useStored = storedValue > 0 && (planLocked || !cost);
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
      colour: r.colour || codeMap.get(r.material_code)?.colour || null,
    };
  });
  const totals = view.reduce(
    (a, v) => ({ job: a.job + v.jobValue, purchase: a.purchase + v.purchaseValue }),
    { job: 0, purchase: 0 },
  );
  const grandTotal = totals.job + totals.purchase;
  const plannedLines = rows.filter((r) => num(r.job_qty) + num(r.purchase_qty) > 0).length;
  const missingCostLines = view.filter((v) => v.missingCost).length;

  // Codes for the active type not already added — for the "Add code" picker.
  const usedCodes = useMemo(() => new Set(rows.map((r) => r.material_code)), [rows]);
  const available = materialCodes.filter(
    (c) => c.material_type === type && !usedCodes.has(c.material_code),
  );
  // Add-material cascade: pick a base fabric first, then the code narrows to it.
  const baseFabrics = useMemo(
    () => [...new Set(available.map((c) => c.base_fabric_code).filter(Boolean))].sort() as string[],
    [available],
  );
  const codeChoices = addBase
    ? available.filter((c) => c.base_fabric_code === addBase)
    : available;
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
          <input type="number" min={0} value={row.job_qty} disabled={!editable} onChange={(e) => set(row.key, 'job_qty', e.target.value)} />
          <small title="Approved Job rate per unit">{cost?.job ? `@ ₹${fmt.format(cost.job)} / ${unit}` : 'no rate'}</small>
        </label>
        <label>
          Purchase
          <input type="number" min={0} value={row.purchase_qty} disabled={!editable} onChange={(e) => set(row.key, 'purchase_qty', e.target.value)} />
          <small title="Approved Purchase rate per unit">{cost?.fob ? `@ ₹${fmt.format(cost.fob)} / ${unit}` : 'no rate'}</small>
        </label>
        <label>
          UOM
          <select value={row.uom} disabled={!editable} onChange={(e) => set(row.key, 'uom', e.target.value)}>
            {UOMS.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        {row.material_type === 'dyed' && (
          <label className="wide">
            Colour
            <select value={row.colour} disabled={!editable} onChange={(e) => set(row.key, 'colour', e.target.value)}>
              <option value="">
                {codeMap.get(row.material_code)?.colour ? `${codeMap.get(row.material_code)?.colour} (default)` : '— pick colour —'}
              </option>
              {colours.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
        )}
        <label className="wide">
          Remark
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input value={row.remark} disabled={!editable} placeholder="optional" onChange={(e) => set(row.key, 'remark', e.target.value)} style={{ fontWeight: 400 }} />
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

  function addRow(code: string) {
    if (!code) return;
    const meta = codeMap.get(code);
    setRows((cur) => [
      ...cur,
      {
        key: `new-${code}-${Date.now()}`,
        material_code: code,
        material_type: (meta?.material_type as MaterialType) ?? type,
        colour: meta?.colour ?? '',
        job_qty: '',
        purchase_qty: '',
        uom: 'metres',
        remark: '',
        standard_value: '',
        line_status: null,
        approver_edited: false,
      },
    ]);
    setAddCode('');
    setAddBase('');
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
    const snapshot = rows
      .filter((r) => r.material_code.trim())
      .map((r) => ({
        product_code: r.material_code.trim(),
        material_type: r.material_type,
        colour: r.material_type === 'dyed' ? r.colour : '',
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
      const result = await saveBuyingPlan(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        // First save of a month creates the plan — refresh so Submit becomes available.
        if (!plan?.id) reloadWithToast(result.message ?? 'Saved.');
      } else setError(toastError(result.error));
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
      {frozen ? (
        <ClosedMonthHeader
          planMonth={planMonth}
          status={status}
          submittedAt={plan?.submitted_at ?? null}
          decisionAt={plan?.approved_at ?? null}
          monthHref={(m) => `/buying-plan?month=${m}&type=material`}
          onExport={exportCsv}
          exportDisabled={!view.length}
          chipRef={modeRef}
        />
      ) : (
      <div className="bp-pagebar">
        <div className="bp-pagebar-left">
          <Field label="Month">
            <select
              value={planMonth}
              onChange={(event) => {
                window.location.href = `/buying-plan?month=${event.target.value}&type=material`;
              }}
            >
              {[-1, 0, 1, 2].map((delta) => {
                const month = addMonths(planMonth, delta);
                return (
                  <option key={month} value={month}>
                    {monthLabel(month)}
                  </option>
                );
              })}
            </select>
          </Field>
          <StatusBadge status={status} edited={plan?.edited_before_approval} approverEdited={plan?.approver_edited} />
          {frozen ? (
            <span className="bp-badge gray" ref={modeRef} title="The month is over — this plan is shown as it was entered">
              <Eye size={13} aria-hidden="true" /> View only
            </span>
          ) : (
            <div className="segment wf-segment" ref={modeRef} style={{ scrollMarginTop: 96 }}>
              <button type="button" className={mode === 'view' ? 'active' : ''} onClick={() => setMode('view')}>
                <Eye size={14} /> View
              </button>
              <button type="button" className={mode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>
                <ClipboardList size={14} /> Input
              </button>
            </div>
          )}
        </div>
        <div className="bp-pagebar-right">
        {editable && mode === 'input' && (
          <>
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
            <button type="button" className="wf-btn wf-btn-ghost" onClick={downloadTemplate}>
              <Download size={15} /> Template
            </button>
            <button type="button" className="wf-btn wf-btn-ghost" onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> Import CSV
            </button>
            {/* A code has to exist before it can be planned. Deep-links to the add form for
                the active type — Raw goes to Fabric Master (its single source of truth),
                Dyed / Trim to Material Master — in a new tab so the draft grid isn't lost. */}
            <a
              className="wf-btn wf-btn-ghost"
              href={type === 'raw' ? '/fabric-master' : `/material-master?type=${type}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Create a new ${TYPE_LABEL[type].toLowerCase()} code, then pick it from the list below`}
            >
              <ExternalLink size={15} /> Add new {TYPE_LABEL[type].toLowerCase()}
            </a>
          </>
        )}
          <button type="button" className="wf-btn wf-btn-ghost" onClick={exportCsv} disabled={!view.length}>
            <Download size={15} /> Export
          </button>
          {editable && mode === 'input' && (
            <button type="button" className="wf-btn wf-btn-ghost" onClick={save} disabled={pending}>
              <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
            </button>
          )}
          {canSubmit(role, status) && !frozen && (
            <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !plan?.id} title={!plan?.id ? 'Save the plan first' : undefined}>
              <Send size={15} /> Submit for approval
            </button>
          )}
        </div>
      </div>
      )}

      {!isPlanWindowOpen(planMonth) && (
        <Notice tone="warn">
          The window for {monthLabel(planMonth)} opens seven days before the month starts. You can
          still draft ahead.
        </Notice>
      )}

      <Notice tone="info">
        Fabric / raw-material buying, on its own approval track. <strong>Job Work</strong> pays for a
        service (e.g. dyeing); <strong>Purchase</strong> buys the material outright — two distinct
        budgets. Rates come from the approved{' '}
        <Link href="/standard-cost?track=material">Material Standard Cost</Link>; enter a quantity and the
        value computes automatically.
      </Notice>

      {!editable && !frozen && mode === 'input' && (
        <Notice tone="warn">
          This month’s plan is {status === 'approved' ? 'approved and locked' : 'read-only'}. Pick
          another month above to draft a new plan.
        </Notice>
      )}

      {plan?.rejection_notes && status === 'rejected' && (
        <Notice tone="error">
          <strong>Rejected.</strong> {plan.rejection_notes}
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
          planMonth={planMonth}
          decision={canDecideLines ? (v) => decisionCell(v.row as Row) : undefined}
          bulk={bulkDecide}
        />
      )}

      {mode === 'input' && (
        <>
          <div className="bp-metrics bp-input-metrics" aria-label="Material plan input summary">
            <div className="bp-metric">
              <div className="label">Lines in plan</div>
              <div className="value">{fmt.format(plannedLines)}</div>
              <div className="sub">{fmt.format(rows.length)} material lines on sheet</div>
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

          <div className="bp-sticky">
            <div className="bp-card bp-toolbar-card">
              <div className="bp-toolbar bp-mat-toolbar">
        <div className="segment wf-segment">
          {TYPES.map((t) => {
            const count = rows.filter((r) => r.material_type === t.key).length;
            return (
              <button
                key={t.key}
                type="button"
                className={type === t.key ? 'active' : ''}
                onClick={() => setType(t.key)}
              >
                {t.label}
                {count > 0 && <span className="wf-seg-count">{count}</span>}
              </button>
            );
          })}
        </div>
        {editable && (
          <div className="bp-mat-add">
            {baseFabrics.length > 0 && (
              <select
                className="wf-add-select"
                value={addBase}
                onChange={(e) => setAddBase(e.target.value)}
                disabled={!available.length}
                aria-label="Base fabric"
              >
                <option value="">All base fabrics</option>
                {baseFabrics.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            )}
            <select className="wf-add-select" value={addCode} onChange={(e) => addRow(e.target.value)} disabled={!codeChoices.length}>
              <option value="">
                {codeChoices.length ? `Add ${TYPE_LABEL[type].toLowerCase()} code (${codeChoices.length})` : 'All codes added'}
              </option>
              {codeChoices.map((c) => (
                <option key={c.material_code} value={c.material_code}>
                  {c.material_code}
                  {c.colour ? ` · ${c.colour}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}
                <span className="bp-toolbar-count">{shownRows.length} {TYPE_LABEL[type].toLowerCase()} line{shownRows.length === 1 ? '' : 's'}</span>
              </div>
            </div>
          </div>

          <section className="bp-card">
            <div className="bp-cardhead">
              <div>
                <h2>
                  Fill the plan
                  <InfoDot text={"WHAT: where this month's material quantities are typed in.\n\nHOW: per material code, quantity as Job Work or Purchase; value = quantity × the approved Material Standard Cost for that route.\n\nUSE: a material with no approved cost shows no value — get it approved on Standard Cost (Material track) first."} />
                </h2>
                <span className="wf-subtle">Enter Job Work and Purchase quantities per {TYPE_LABEL[type].toLowerCase()} code. Zero quantities stay out of the submitted plan.</span>
              </div>
              <StatusBadge status={status} edited={plan?.edited_before_approval} approverEdited={plan?.approver_edited} />
            </div>
            <div className="bp-cardbody bp-cardbody-flush">
          <PlanLineViews
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
            defaultView="table"
            kanban={MAT_INPUT_KANBAN}
            editor={inputEditor}
            decision={canDecideLines ? (key) => {
              const r = rows.find((x) => x.key === key);
              return r && num(r.job_qty) + num(r.purchase_qty) > 0 ? decisionCell(r) : null;
            } : undefined}
            table={
              <div className="table-panel wf-grid-panel">
                <div className="table-scroll">
                  <table className="wide-table wf-grid">
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
                              <select
                                value={row.colour}
                                disabled={!editable}
                                onChange={(e) => set(row.key, 'colour', e.target.value)}
                              >
                                <option value="">
                                  {codeMap.get(row.material_code)?.colour
                                    ? `${codeMap.get(row.material_code)?.colour} (default)`
                                    : '— pick colour —'}
                                </option>
                                {colours.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            </td>
                          )}
                          <td className="num input-col wf-cell-input">
                            <input type="number" min={0} value={row.job_qty} disabled={!editable} onChange={(e) => set(row.key, 'job_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{cost ? fmt.format(cost.job) : '—'}</td>
                          <td className="num input-col wf-cell-input">
                            <input type="number" min={0} value={row.purchase_qty} disabled={!editable} onChange={(e) => set(row.key, 'purchase_qty', e.target.value)} />
                          </td>
                          <td className="num wf-cell-calc">{cost ? fmt.format(cost.fob) : '—'}</td>
                          <td className="input-col wf-cell-input">
                            <select value={row.uom} disabled={!editable} onChange={(e) => set(row.key, 'uom', e.target.value)}>
                              {UOMS.map((u) => (
                                <option key={u} value={u}>
                                  {u}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="input-col wf-cell-input">
                            <input value={row.remark} disabled={!editable} placeholder="optional" onChange={(e) => set(row.key, 'remark', e.target.value)} />
                          </td>
                          <td className="num strong wf-cell-calc">
                            {missingCost ? <span className="wf-over-tag">no approved cost</span> : money.format(value)}
                          </td>
                          {canDecideLines && <td>{num(row.job_qty) + num(row.purchase_qty) > 0 ? decisionCell(row) : <span className="wf-subtle">—</span>}</td>}
                          {editable && (
                            <td>
                              <button type="button" className="wf-icon-btn" aria-label={`Remove ${row.material_code}`} onClick={() => setRows((cur) => cur.filter((r) => r.key !== row.key))}>
                                <Trash2 size={14} />
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {!shownRows.length && (
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
            <div className="bp-input-footer">
              <div>
                <strong>{grandTotal ? money.format(grandTotal) : 'value pending'}</strong>
                <span>Job Work {money.format(totals.job)} · Purchase {money.format(totals.purchase)} · {plannedLines} planned line{plannedLines === 1 ? '' : 's'}</span>
              </div>
              <div className="bp-actions">
              {editable && (
                <button type="button" className="wf-btn wf-btn-ghost" onClick={save} disabled={pending}>
                  <Save size={15} /> {pending ? 'Saving…' : 'Save draft'}
                </button>
              )}
              {canSubmit(role, status) && !frozen && (
                <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !plan?.id}>
                  <Send size={15} /> Submit for approval
                </button>
              )}
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
