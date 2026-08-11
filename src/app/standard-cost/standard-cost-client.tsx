'use client';

import { Fragment, useMemo, useRef, useState, useTransition } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Download,
  Lock,
  Plus,
  Save,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  proposeCost,
  rejectCost,
  renegotiateCost,
  saveMaterialCost,
  saveStandardCost,
  saveStandardCostLines,
  setTargetCost,
  signOffCost,
  submitActualRate,
  type ActionResult,
} from '@/lib/forms/actions';
import {
  COST_STAGE_LABEL,
  COST_STAGE_TONE,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
  nextActor,
} from '@/lib/forms/cost';
import { canEdit } from '@/lib/forms/approval';
import { csvObjects, downloadCsv } from '@/lib/csv';
import { Field, Notice } from '@/components/forms/form-layout';
import type { SdRole, StandardCost, StandardCostLine } from '@/lib/forms/types';

const disp = (v: number | null) => (v == null ? '—' : String(v));

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
  const codeLabel = isMat ? 'Material code' : 'Product code';
  const jobLabel = isMat ? 'Job Work' : 'Job';
  const fobLabel = isMat ? 'Purchase' : 'FOB';

  const editable = canEdit(role, 'draft');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newCode, setNewCode] = useState('');

  const signedOff = costs.filter((c) => c.neg_stage === 'signed_off' || c.status === 'approved').length;

  const linesByCode = useMemo(() => {
    const m = new Map<string, StandardCostLine[]>();
    for (const l of lines) m.set(l.product_code, [...(m.get(l.product_code) ?? []), l]);
    return m;
  }, [lines]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? costs.filter((c) => c.product_code.toLowerCase().includes(q)) : costs;
  }, [costs, filter]);

  function addCode() {
    if (!newCode.trim()) {
      setError(`Enter a ${codeLabel.toLowerCase()}.`);
      return;
    }
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('product_code', newCode.trim());
    start(async () => {
      // upsert by code — seeds a row on the right track to then propose.
      const result = await (isMat ? saveMaterialCost : saveStandardCost)(fd);
      if (result.ok) window.location.reload();
      else setError(result.error);
    });
  }

  const colCount = isMat ? 7 : 8;

  return (
    <>
      <Notice tone="info">
        Cost is <strong>negotiated</strong>, not just approved: team{' '}
        <strong>proposes</strong> → Mahesh sets a <strong>target</strong> → team returns with the{' '}
        <strong>actual vendor rate</strong> → Mahesh <strong>signs off</strong>, and that becomes the
        Standard Cost the Buying Plan values from. {signedOff} of {costs.length}{' '}
        {isMat ? 'materials' : 'products'} are signed off.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="wf-form-panel">
          <div className="wf-form-grid">
            <Field label={`Add a ${codeLabel.toLowerCase()}`} hint="seeds a row you can then propose">
              <input
                value={newCode}
                placeholder={isMat ? 'e.g. TRM07' : 'e.g. SDRPT'}
                onChange={(e) => setNewCode(e.target.value)}
              />
            </Field>
            <button type="button" className="wf-btn wf-btn-primary" onClick={addCode} disabled={pending}>
              <Plus size={15} /> Add to sheet
            </button>
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter code…"
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
                <th className="num">Proposed</th>
                <th className="num">Target</th>
                <th className="num input-col">{jobLabel} rate</th>
                <th className="num input-col">{fobLabel} rate</th>
                {!isMat && <th className="num input-col">E-FOB rate</th>}
                <th>Stage</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((cost) => (
                <Fragment key={cost.product_code}>
                  <CostRow
                    cost={cost}
                    role={role}
                    track={track}
                    expanded={expanded === cost.product_code}
                    onToggle={
                      isMat
                        ? undefined
                        : () => setExpanded(expanded === cost.product_code ? null : cost.product_code)
                    }
                  />
                  {!isMat && expanded === cost.product_code && (
                    <tr className="wf-cost-detail-row">
                      <td colSpan={colCount}>
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
                  <td colSpan={colCount} className="wf-empty-cell">
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
  track,
  expanded,
  onToggle,
}: {
  cost: StandardCost;
  role: SdRole;
  track: 'fg' | 'material';
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const isMat = track === 'material';
  const stage = cost.neg_stage;
  const stageKey = stage ?? '';

  const [job, setJob] = useState(cost.job_cost?.toString() ?? '');
  const [fob, setFob] = useState(cost.fob_cost?.toString() ?? '');
  const [efob, setEfob] = useState(cost.efob_cost?.toString() ?? '');
  const [proposed, setProposed] = useState('');
  const [target, setTarget] = useState('');
  const [noteMode, setNoteMode] = useState<'renegotiate' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const rateEditable = canSubmitRate(role, stage) && !cost.frozen;

  function act(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) {
    setErr(null);
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) window.location.reload();
      else setErr(res.error);
    });
  }

  const rateCell = (value: string, set: (v: string) => void) =>
    rateEditable ? (
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
        {!isMat && !cost.documented && stage == null && (
          <span className="wf-gap-tag">Undocumented — data gap</span>
        )}
      </td>
      <td className="num">{disp(cost.proposed_cost)}</td>
      <td className="num">{disp(cost.target_cost)}</td>
      <td className="num input-col">{rateCell(job, setJob)}</td>
      <td className="num input-col">{rateCell(fob, setFob)}</td>
      {!isMat && <td className="num input-col">{rateCell(efob, setEfob)}</td>}
      <td>
        <span className={`wf-status tone-${COST_STAGE_TONE[stageKey]}`}>
          {COST_STAGE_LABEL[stageKey]}
        </span>
        <small className="wf-subtle">{nextActor(stage)}</small>
        {stage === 'rejected' && cost.rejection_notes && (
          <small className="wf-subtle">{cost.rejection_notes}</small>
        )}
        {stage === 'renegotiate' && cost.negotiation_notes && (
          <small className="wf-subtle">{cost.negotiation_notes}</small>
        )}
      </td>
      <td>
        <div className="wf-cost-actions">
          {err && <small className="wf-line-error">{err}</small>}

          {canPropose(role, stage) && !cost.frozen && (
            <div className="wf-issue-row">
              <input
                className="wf-mini-input"
                type="number"
                min={0}
                placeholder="expected"
                value={proposed}
                onChange={(e) => setProposed(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                onClick={() => act(proposeCost, { proposed_cost: proposed })}
              >
                Propose
              </button>
            </div>
          )}

          {canSetTarget(role, stage) && (
            <div className="wf-issue-row">
              <input
                className="wf-mini-input"
                type="number"
                min={0}
                placeholder="target"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                onClick={() => act(setTargetCost, { target_cost: target })}
              >
                Set target
              </button>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => setNoteMode('reject')}
              >
                Reject
              </button>
            </div>
          )}

          {canSubmitRate(role, stage) && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={busy}
              onClick={() =>
                act(submitActualRate, {
                  job_cost: job,
                  fob_cost: fob,
                  ...(isMat ? {} : { efob_cost: efob }),
                })
              }
            >
              <Save size={13} /> Submit rate
            </button>
          )}

          {canSignOff(role, stage) && (
            <div className="wf-issue-row">
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                onClick={() => act(signOffCost, {})}
              >
                Sign off
              </button>
              {canRenegotiate(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setNoteMode('renegotiate')}
                >
                  Renegotiate
                </button>
              )}
              {canRejectCost(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost wf-btn-sm"
                  onClick={() => setNoteMode('reject')}
                >
                  Reject
                </button>
              )}
            </div>
          )}

          {noteMode && (
            <div className="wf-issue-row">
              <input
                className="wf-mini-input"
                placeholder={`${noteMode} reason`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy || !note.trim()}
                onClick={() =>
                  act(noteMode === 'reject' ? rejectCost : renegotiateCost, { note })
                }
              >
                Confirm
              </button>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => {
                  setNoteMode(null);
                  setNote('');
                }}
              >
                Cancel
              </button>
            </div>
          )}
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
 * The expandable "actual standard cost" panel — the detailed record the approver
 * reviews. Documents CM cost, Total PO Average cost, CAD/RFP links, and the
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
    setMsg(`Loaded ${imported.length} line(s)${skipped.length ? `, skipped ${skipped.length}` : ''}. Review, then Save.`);
  }

  function saveDetail() {
    setErr(null);
    setMsg(null);
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
