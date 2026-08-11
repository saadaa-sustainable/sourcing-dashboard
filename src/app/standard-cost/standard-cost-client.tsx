'use client';

import { Fragment, useMemo, useRef, useState, useTransition } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Lock,
  Plus,
  Save,
  Send,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  saveMaterialCost,
  saveStandardCost,
  saveStandardCostLines,
  submitMaterialCost,
  submitStandardCost,
} from '@/lib/forms/actions';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type { SdRole, StandardCost, StandardCostLine } from '@/lib/forms/types';

export function StandardCostClient({
  costs,
  lines = [],
  role,
  track = 'fg',
}: {
  costs: StandardCost[];
  lines?: StandardCostLine[];
  role: SdRole;
  track?: 'fg' | 'material';
}) {
  const isMat = track === 'material';
  const saveAction = isMat ? saveMaterialCost : saveStandardCost;
  const submitAction = isMat ? submitMaterialCost : submitStandardCost;
  const codeLabel = isMat ? 'Material code' : 'Product code';
  const fobLabel = isMat ? 'Purchase cost' : 'FOB cost';

  const editable = canEdit(role, 'draft');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [draft, setDraft] = useState({ product_code: '', job_cost: '', fob_cost: '', efob_cost: '' });

  const approved = costs.filter((c) => c.status === 'approved').length;
  const undocumented = costs.filter((c) => !c.documented).length;

  const linesByCode = useMemo(() => {
    const m = new Map<string, StandardCostLine[]>();
    for (const l of lines) m.set(l.product_code, [...(m.get(l.product_code) ?? []), l]);
    return m;
  }, [lines]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? costs.filter((c) => c.product_code.toLowerCase().includes(q)) : costs;
  }, [costs, filter]);

  function run(payload: FormData, action: typeof saveStandardCost) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        window.location.reload();
      } else {
        setError(result.error);
      }
    });
  }

  function addCost() {
    if (!draft.product_code.trim()) {
      setError(`Enter a ${codeLabel.toLowerCase()}.`);
      return;
    }
    const fd = new FormData();
    fd.set('product_code', draft.product_code.trim());
    fd.set('job_cost', draft.job_cost);
    fd.set('fob_cost', draft.fob_cost);
    if (!isMat) fd.set('efob_cost', draft.efob_cost);
    run(fd, saveAction);
  }

  return (
    <>
      <Notice tone="info">
        {approved} of {costs.length} {isMat ? 'materials' : 'products'} have an approved
        standard cost. The Buying Plan multiplies each{' '}
        {isMat ? 'Job Work / Purchase' : 'PO-type'} quantity by its own rate.
        {isMat
          ? ' Job Work is a service (e.g. dyeing); Purchase buys the material outright.'
          : ` Click a product to document its actual cost. ${undocumented} product(s) are still undocumented.`}
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="wf-form-panel">
          <div className="wf-form-grid">
            <Field label={codeLabel} hint="Add a code not already listed">
              <input
                value={draft.product_code}
                placeholder={isMat ? 'e.g. TRM07' : 'e.g. SDRPT'}
                onChange={(e) => setDraft({ ...draft, product_code: e.target.value })}
              />
            </Field>
            <Field label={isMat ? 'Job Work cost' : 'Job cost'}>
              <input
                type="number"
                min={0}
                value={draft.job_cost}
                onChange={(e) => setDraft({ ...draft, job_cost: e.target.value })}
              />
            </Field>
            <Field label={fobLabel}>
              <input
                type="number"
                min={0}
                value={draft.fob_cost}
                onChange={(e) => setDraft({ ...draft, fob_cost: e.target.value })}
              />
            </Field>
            {!isMat && (
              <Field label="E-FOB cost">
                <input
                  type="number"
                  min={0}
                  value={draft.efob_cost}
                  onChange={(e) => setDraft({ ...draft, efob_cost: e.target.value })}
                />
              </Field>
            )}
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={addCost}
              disabled={pending}
            >
              <Save size={15} /> Add / update
            </button>
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter product code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>{codeLabel}</th>
                <th className="num input-col">{isMat ? 'Job Work cost' : 'Job cost'}</th>
                <th className="num input-col">{fobLabel}</th>
                {!isMat && <th className="num input-col">E-FOB cost</th>}
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((cost) => (
                <Fragment key={cost.product_code}>
                  <CostRow
                    cost={cost}
                    role={role}
                    pending={pending}
                    track={track}
                    expanded={expanded === cost.product_code}
                    onToggle={
                      isMat
                        ? undefined
                        : () =>
                            setExpanded(expanded === cost.product_code ? null : cost.product_code)
                    }
                    onSave={(fd) => run(fd, saveAction)}
                    onSubmit={(fd) => run(fd, submitAction)}
                  />
                  {!isMat && expanded === cost.product_code && (
                    <tr className="wf-cost-detail-row">
                      <td colSpan={6}>
                        <CostDetail
                          cost={cost}
                          lines={linesByCode.get(cost.product_code) ?? []}
                          editable={!cost.frozen && canEdit(role, cost.status)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={isMat ? 5 : 6} className="wf-empty-cell">
                    No {isMat ? 'materials' : 'products'} match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function CostRow({
  cost,
  role,
  pending,
  track,
  expanded,
  onToggle,
  onSave,
  onSubmit,
}: {
  cost: StandardCost;
  role: SdRole;
  pending: boolean;
  track: 'fg' | 'material';
  expanded?: boolean;
  onToggle?: () => void;
  onSave: (fd: FormData) => void;
  onSubmit: (fd: FormData) => void;
}) {
  const isMat = track === 'material';
  const [job, setJob] = useState(cost.job_cost?.toString() ?? '');
  const [fob, setFob] = useState(cost.fob_cost?.toString() ?? '');
  const [efob, setEfob] = useState(cost.efob_cost?.toString() ?? '');

  const rowEditable = !cost.frozen && canEdit(role, cost.status);
  const dirty =
    job !== (cost.job_cost?.toString() ?? '') ||
    fob !== (cost.fob_cost?.toString() ?? '') ||
    (!isMat && efob !== (cost.efob_cost?.toString() ?? ''));

  const save = () => {
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set('job_cost', job);
    fd.set('fob_cost', fob);
    if (!isMat) fd.set('efob_cost', efob);
    onSave(fd);
  };
  const submit = () => {
    const fd = new FormData();
    fd.set('id', String(cost.id));
    onSubmit(fd);
  };

  const cell = (value: string, set: (v: string) => void) =>
    rowEditable ? (
      <input type="number" min={0} value={value} onChange={(e) => set(e.target.value)} />
    ) : (
      <span>{value === '' ? '—' : value}</span>
    );

  return (
    <tr className={expanded ? 'wf-cost-row-open' : undefined}>
      <td className="mono">
        <span className="wf-cost-code">
          {onToggle && (
            <button
              type="button"
              className="wf-expand-btn"
              aria-expanded={!!expanded}
              aria-label={expanded ? 'Collapse' : 'Show cost detail'}
              onClick={onToggle}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
          {cost.product_code}
          {cost.frozen && (
            <small className="wf-subtle">
              <Lock size={11} /> frozen
            </small>
          )}
        </span>
        {!isMat && !cost.documented && (
          <span className="wf-gap-tag">Undocumented — data gap</span>
        )}
      </td>
      <td className="num input-col">{cell(job, setJob)}</td>
      <td className="num input-col">{cell(fob, setFob)}</td>
      {!isMat && <td className="num input-col">{cell(efob, setEfob)}</td>}
      <td>
        <StatusBadge status={cost.status} />
        {cost.status === 'rejected' && cost.rejection_notes && (
          <small className="wf-subtle">{cost.rejection_notes}</small>
        )}
      </td>
      <td>
        <div className="wf-issue-row">
          {rowEditable && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              disabled={!dirty || pending}
              onClick={save}
            >
              <Save size={13} /> Save
            </button>
          )}
          {cost.status === 'draft' && canSubmit(role, cost.status) && !cost.frozen && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={pending || dirty}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={submit}
            >
              <Send size={13} /> Submit
            </button>
          )}
          {(cost.status === 'submitted' || cost.status === 'pending_l2') &&
            (canApprove(role, cost.status) ? (
              <ApprovalBar
                entityType={isMat ? 'material_cost' : 'standard_cost'}
                entityId={String(cost.id)}
                entityLabel={`${isMat ? 'Material' : 'Standard'} cost — ${cost.product_code}`}
                onDone={(res) => {
                  if (res.ok) window.location.reload();
                }}
              />
            ) : (
              <span className="wf-subtle">Awaiting approval</span>
            ))}
        </div>
      </td>
    </tr>
  );
}

type LineDraft = {
  key: string;
  colour: string;
  size: string;
  fabric_cost: string;
  cm_cost: string;
  total_cost: string;
};

function toLineDraft(l: StandardCostLine): LineDraft {
  return {
    key: `line-${l.id}`,
    colour: l.colour ?? '',
    size: l.size ?? '',
    fabric_cost: l.fabric_cost?.toString() ?? '',
    cm_cost: l.cm_cost?.toString() ?? '',
    total_cost: l.total_cost?.toString() ?? '',
  };
}

/**
 * The expandable "actual standard cost" panel — the first source of input for
 * approvals. Documents CM cost, Total PO Average cost, CAD/RFP links, and the
 * colour/size cost breakdown (editable + CSV-importable).
 */
function CostDetail({
  cost,
  lines,
  editable,
}: {
  cost: StandardCost;
  lines: StandardCostLine[];
  editable: boolean;
}) {
  const [cm, setCm] = useState(cost.cm_cost?.toString() ?? '');
  const [total, setTotal] = useState(cost.total_po_avg_cost?.toString() ?? '');
  const [cad, setCad] = useState(cost.cad_link ?? '');
  const [rfp, setRfp] = useState(cost.rfp_link ?? '');
  const [rows, setRows] = useState<LineDraft[]>(() => lines.map(toLineDraft));
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  function setRow(key: string, field: keyof LineDraft, value: string) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, [field]: value } : r)));
  }
  function addRow() {
    setRows((cur) => [
      ...cur,
      { key: `new-${cur.length}-${Date.now()}`, colour: '', size: '', fabric_cost: '', cm_cost: '', total_cost: '' },
    ]);
  }

  function downloadTemplate() {
    const examples = rows.length
      ? rows.map((r) => [cost.product_code, r.colour, r.size, r.fabric_cost, r.cm_cost, r.total_cost])
      : [[cost.product_code, 'Navy', 'M', '190', '65', '255']];
    downloadCsv(
      `standard-cost-${cost.product_code}.csv`,
      ['product_code', 'colour', 'size', 'fabric_cost', 'cm_cost', 'total_cost'],
      examples,
    );
  }

  async function onCsvFile(file: File) {
    setErr(null);
    setMsg(null);
    let objects: Record<string, string>[];
    try {
      objects = csvObjects(await file.text());
    } catch {
      setErr('Could not read that file as CSV.');
      return;
    }
    const imported: LineDraft[] = [];
    const skipped: string[] = [];
    objects.forEach((r, i) => {
      const line = i + 2;
      const code = String(r.product_code ?? '').trim();
      // Panel is per-product: only rows for this product are applied.
      if (code && code.toUpperCase() !== cost.product_code.toUpperCase()) {
        return skipped.push(`row ${line}: different product "${code}"`);
      }
      if (!r.colour && !r.size && !r.fabric_cost && !r.cm_cost && !r.total_cost) {
        return skipped.push(`row ${line}: empty`);
      }
      imported.push({
        key: `csv-${i}`,
        colour: String(r.colour ?? '').trim(),
        size: String(r.size ?? '').trim(),
        fabric_cost: String(r.fabric_cost ?? '').trim(),
        cm_cost: String(r.cm_cost ?? '').trim(),
        total_cost: String(r.total_cost ?? '').trim(),
      });
    });
    if (!imported.length) {
      setErr(`No rows imported.${skipped.length ? ` ${skipped.slice(0, 4).join('; ')}` : ' Expected headers: product_code, colour, size, fabric_cost, cm_cost, total_cost.'}`);
      return;
    }
    setRows(imported);
    setMsg(
      `Loaded ${imported.length} line(s)${skipped.length ? `, skipped ${skipped.length}` : ''}. Review, then Save.`,
    );
  }

  function saveDetail() {
    setErr(null);
    setMsg(null);
    // Keep the operative job/fob/efob rates intact while adding the doc fields.
    const header = new FormData();
    header.set('product_code', cost.product_code);
    header.set('job_cost', cost.job_cost?.toString() ?? '');
    header.set('fob_cost', cost.fob_cost?.toString() ?? '');
    header.set('efob_cost', cost.efob_cost?.toString() ?? '');
    header.set('cm_cost', cm);
    header.set('total_po_avg_cost', total);
    header.set('cad_link', cad);
    header.set('rfp_link', rfp);

    const detail = new FormData();
    detail.set('product_code', cost.product_code);
    detail.set(
      'lines',
      JSON.stringify(
        rows.map((r) => ({
          colour: r.colour,
          size: r.size,
          fabric_cost: r.fabric_cost,
          cm_cost: r.cm_cost,
          total_cost: r.total_cost,
        })),
      ),
    );

    start(async () => {
      const h = await saveStandardCost(header);
      if (!h.ok) return setErr(h.error);
      const d = await saveStandardCostLines(detail);
      if (!d.ok) return setErr(d.error);
      window.location.reload();
    });
  }

  return (
    <div className="wf-cost-detail">
      {err && <Notice tone="error">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}

      <div className="wf-form-grid">
        <Field label="CM cost" hint="stitching / cost of manufacturing">
          <input type="number" min={0} value={cm} disabled={!editable} onChange={(e) => setCm(e.target.value)} />
        </Field>
        <Field label="Total PO average cost" hint="entered directly">
          <input type="number" min={0} value={total} disabled={!editable} onChange={(e) => setTotal(e.target.value)} />
        </Field>
        <Field label="CAD link">
          <input value={cad} disabled={!editable} placeholder="https://…" onChange={(e) => setCad(e.target.value)} />
        </Field>
        <Field label="RFP link">
          <input value={rfp} disabled={!editable} placeholder="https://…" onChange={(e) => setRfp(e.target.value)} />
        </Field>
      </div>

      <div className="wf-cost-detail-head">
        <h4>Colour / size costing</h4>
        {editable && (
          <div className="wf-toolbar-right">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onCsvFile(f);
                e.target.value = '';
              }}
            />
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadTemplate}>
              <Download size={13} /> Template
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => fileRef.current?.click()}>
              <Upload size={13} /> Import CSV
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={addRow}>
              <Plus size={13} /> Add line
            </button>
          </div>
        )}
      </div>

      <table className="wf-grid wf-cost-lines">
        <thead>
          <tr>
            <th>Colour</th>
            <th>Size</th>
            <th className="num input-col">Fabric</th>
            <th className="num input-col">CM</th>
            <th className="num input-col">Total</th>
            {editable && <th aria-label="Remove" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="input-col"><input value={r.colour} disabled={!editable} onChange={(e) => setRow(r.key, 'colour', e.target.value)} /></td>
              <td className="input-col"><input value={r.size} disabled={!editable} onChange={(e) => setRow(r.key, 'size', e.target.value)} /></td>
              <td className="num input-col"><input type="number" min={0} value={r.fabric_cost} disabled={!editable} onChange={(e) => setRow(r.key, 'fabric_cost', e.target.value)} /></td>
              <td className="num input-col"><input type="number" min={0} value={r.cm_cost} disabled={!editable} onChange={(e) => setRow(r.key, 'cm_cost', e.target.value)} /></td>
              <td className="num input-col"><input type="number" min={0} value={r.total_cost} disabled={!editable} onChange={(e) => setRow(r.key, 'total_cost', e.target.value)} /></td>
              {editable && (
                <td>
                  <button type="button" className="wf-icon-btn" aria-label="Remove line" onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}>
                    <Trash2 size={13} />
                  </button>
                </td>
              )}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={editable ? 6 : 5} className="wf-empty-cell">
                No colour/size cost lines yet{editable ? ' — add one, or import a CSV.' : '.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editable && (
        <div className="wf-cost-detail-foot">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={saveDetail} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save cost detail'}
          </button>
        </div>
      )}
    </div>
  );
}
