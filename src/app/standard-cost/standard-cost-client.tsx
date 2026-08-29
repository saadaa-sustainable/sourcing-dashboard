'use client';

import { Fragment, useMemo, useRef, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { ChevronDown, ChevronRight, Download, Lock, Plus, Save, Trash2, Upload } from 'lucide-react';
import {
  confirmCmRate,
  confirmFabricRate,
  proposeCost,
  rejectCost,
  renegotiateCost,
  saveCmtpComponents,
  saveCostStandards,
  saveMaterialCost,
  saveStandardCost,
  saveStandardCostLines,
  setTargetCost,
  signOffCost,
  submitActualRate,
  type ActionResult,
} from '@/lib/forms/actions';
import {
  CMTP_HEADS,
  CMTP_MANDATORY,
  COST_STAGE_LABEL,
  COST_STAGE_TONE,
  canConfirmCm,
  canConfirmFabric,
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
import type {
  CmtpComponent,
  CostStandards,
  SdRole,
  StandardCost,
  StandardCostLine,
} from '@/lib/forms/types';

const disp = (v: number | null) => (v == null ? '—' : String(v));

export function StandardCostClient({
  costs,
  lines = [],
  cmtp = [],
  fabricRates = {},
  fabricCodes = [],
  standards,
  initialOpen = null,
  role,
  track = 'fg',
}: {
  costs: StandardCost[];
  lines?: StandardCostLine[];
  cmtp?: CmtpComponent[];
  fabricRates?: Record<string, number>;
  fabricCodes?: string[];
  standards?: CostStandards;
  initialOpen?: string | null;
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
  // A newly-added product opens straight into its cost format.
  const [expanded, setExpanded] = useState<string | null>(initialOpen);
  const [newCode, setNewCode] = useState('');

  const signedOff = costs.filter((c) => c.neg_stage === 'signed_off' || c.status === 'approved').length;

  const linesByCode = useMemo(() => {
    const m = new Map<string, StandardCostLine[]>();
    for (const l of lines) m.set(l.product_code, [...(m.get(l.product_code) ?? []), l]);
    return m;
  }, [lines]);

  const cmtpByCode = useMemo(() => {
    const m = new Map<string, CmtpComponent[]>();
    for (const c of cmtp) m.set(c.product_code, [...(m.get(c.product_code) ?? []), c]);
    return m;
  }, [cmtp]);

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
    const code = newCode.trim();
    const fd = new FormData();
    fd.set('product_code', code);
    start(async () => {
      // upsert by code — seeds a row; then open straight into its cost format.
      const result = await (isMat ? saveMaterialCost : saveStandardCost)(fd);
      if (result.ok) {
        window.location.href = isMat
          ? '/standard-cost?track=material'
          : `/standard-cost?open=${encodeURIComponent(code.toUpperCase())}`;
      } else setError(result.error);
    });
  }

  const colCount = isMat ? 7 : 8;

  return (
    <>
      <Notice tone="info">
        Cost is <strong>negotiated</strong>, not just approved: team{' '}
        <strong>proposes</strong> (fill the {jobLabel} / {fobLabel}{isMat ? '' : ' / E-FOB'} rate that
        applies) → Mahesh sets a <strong>target</strong> → team returns with the{' '}
        <strong>actual vendor rate</strong> → Mahesh <strong>signs off</strong>, and that becomes the
        Standard Cost the Buying Plan values from. {signedOff} of {costs.length}{' '}
        {isMat ? 'materials' : 'products'} are signed off.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {!isMat && standards && <StandardFieldsPanel standards={standards} editable={editable} />}

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
                          cmtp={cmtpByCode.get(cost.product_code) ?? []}
                          fabricRates={fabricRates}
                          fabricCodes={fabricCodes}
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

/** Document-once standard fields — the same across all products. */
function StandardFieldsPanel({
  standards,
  editable,
}: {
  standards: CostStandards;
  editable: boolean;
}) {
  const [fabric, setFabric] = useState(standards.fabric_cost?.toString() ?? '');
  const [dyeing, setDyeing] = useState(standards.dyeing_cost?.toString() ?? '');
  const [shrink, setShrink] = useState(standards.shrinkage_pct?.toString() ?? '');
  const [margin, setMargin] = useState(standards.margin_pct?.toString() ?? '');
  const [terms, setTerms] = useState(standards.payment_terms ?? '');
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);

  function save() {
    const fd = new FormData();
    fd.set('fabric_cost', fabric);
    fd.set('dyeing_cost', dyeing);
    fd.set('shrinkage_pct', shrink);
    fd.set('margin_pct', margin);
    fd.set('payment_terms', terms);
    start(async () => {
      const res = await saveCostStandards(fd);
      setMsg(res.ok ? 'Saved.' : res.error);
      if (res.ok) reloadWithToast();
    });
  }

  return (
    <details className="wf-standards-panel" open={false}>
      <summary>Standard fields — documented once, same across all products</summary>
      {msg && <Notice tone="ok">{msg}</Notice>}
      <div className="wf-form-grid">
        <Field label="Fabric cost"><input type="number" min={0} value={fabric} disabled={!editable} onChange={(e) => setFabric(e.target.value)} /></Field>
        <Field label="Dyeing cost"><input type="number" min={0} value={dyeing} disabled={!editable} onChange={(e) => setDyeing(e.target.value)} /></Field>
        <Field label="Shrinkage %"><input type="number" min={0} value={shrink} disabled={!editable} onChange={(e) => setShrink(e.target.value)} /></Field>
        <Field label="Margin %"><input type="number" min={0} value={margin} disabled={!editable} onChange={(e) => setMargin(e.target.value)} /></Field>
        <Field label="Payment terms"><input value={terms} disabled={!editable} placeholder="e.g. 30 days" onChange={(e) => setTerms(e.target.value)} /></Field>
        {editable && (
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save standard fields'}
          </button>
        )}
      </div>
    </details>
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
  const jobLabel = isMat ? 'Job Work' : 'Job';
  const fobLabel = isMat ? 'Purchase' : 'FOB';
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

  // Rates are fillable both when the team proposes (so a proposal can name its PO
  // type) and when it later submits the actual vendor rate.
  const rateEditable = (canPropose(role, stage) || canSubmitRate(role, stage)) && !cost.frozen;

  function act(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) {
    setErr(null);
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) reloadWithToast();
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
            <div className="wf-issue-row wf-issue-row-wrap">
              <span className="wf-subtle wf-propose-hint">
                Fill the {jobLabel} / {fobLabel}{isMat ? '' : ' / E-FOB'} rate(s) that apply →
              </span>
              <input
                className="wf-mini-input"
                type="number"
                min={0}
                placeholder="expected (optional)"
                value={proposed}
                onChange={(e) => setProposed(e.target.value)}
              />
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={busy}
                onClick={() =>
                  act(proposeCost, {
                    proposed_cost: proposed,
                    job_cost: job,
                    fob_cost: fob,
                    ...(isMat ? {} : { efob_cost: efob }),
                  })
                }
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
              {isMat ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(signOffCost, {})}>
                  Sign off
                </button>
              ) : canConfirmFabric(role, stage, !!cost.fabric_confirmed_at) ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmFabricRate, {})}>
                  1 · Confirm fabric rate
                </button>
              ) : canConfirmCm(role, stage, !!cost.fabric_confirmed_at, !!cost.cm_confirmed_at) ? (
                <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(confirmCmRate, {})}>
                  2 · Confirm CMTP → sign off
                </button>
              ) : null}
              {!isMat && cost.fabric_confirmed_at && !cost.cm_confirmed_at && (
                <span className="wf-tag-approved">fabric ✓</span>
              )}
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

const SIZES = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'] as const;
const numv = (s: string) => Number(s) || 0;

/**
 * The expandable cost record — an Excel-paste-friendly CM cost matrix (sizes as
 * rows). Fabric rate is pulled from the Fabric Cost sheet (computed, read-only);
 * CM is entered (paste a column straight from Excel); Total and the size-wise
 * average compute automatically. Two output views: the editable matrix, a formal
 * Document view, and View More for the full record.
 */
function CostDetail({
  cost,
  lines,
  cmtp,
  fabricRates,
  fabricCodes,
  editable,
}: {
  cost: StandardCost;
  lines: StandardCostLine[];
  cmtp: CmtpComponent[];
  fabricRates: Record<string, number>;
  fabricCodes: string[];
  editable: boolean;
}) {
  const [view, setView] = useState<'cmtp' | 'matrix' | 'document' | 'more'>('cmtp');
  const [fabricCode, setFabricCode] = useState(cost.fabric_code ?? '');
  const [cmBySize, setCmBySize] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const l of lines) {
      if (l.size && l.cm_cost != null) m[l.size.toUpperCase()] = String(l.cm_cost);
    }
    return m;
  });
  const [total, setTotal] = useState(cost.total_po_avg_cost?.toString() ?? '');
  const [cad, setCad] = useState(cost.cad_link ?? '');
  const [rfp, setRfp] = useState(cost.rfp_link ?? '');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const fabricRate = fabricCode ? fabricRates[fabricCode] : undefined;

  // Per-size computed rows.
  const matrix = SIZES.map((size) => {
    const cm = cmBySize[size] ?? '';
    const has = cm !== '';
    const totalCell = has ? (fabricRate ?? 0) + numv(cm) : null;
    return { size, cm, fabric: fabricRate ?? null, total: totalCell, has };
  });
  const filled = matrix.filter((r) => r.has);
  const sizeAvg = filled.length
    ? Math.round(filled.reduce((s, r) => s + (r.total ?? 0), 0) / filled.length)
    : null;

  function setCm(size: string, value: string) {
    setCmBySize((cur) => ({ ...cur, [size]: value }));
  }

  // Excel paste: a column of CM values (newline-separated) fills down from the
  // pasted cell. Tabs are tolerated — first token per line is taken as the CM.
  function onCmPaste(e: React.ClipboardEvent, startIdx: number) {
    const text = e.clipboardData.getData('text');
    if (!text || !/[\n\t]/.test(text)) return; // single value → let it paste normally
    e.preventDefault();
    const vals = text
      .split(/\r\n|\r|\n/)
      .map((line) => line.split('\t')[0].trim())
      .filter((_, i, arr) => i < arr.length);
    setCmBySize((cur) => {
      const next = { ...cur };
      vals.forEach((v, k) => {
        const size = SIZES[startIdx + k];
        if (size && v !== '') next[size] = v;
      });
      return next;
    });
  }

  function copyMatrix() {
    const head = 'Size\tFabric\tCMTP\tTotal';
    const body = matrix
      .filter((r) => r.has)
      .map((r) => `${r.size}\t${r.fabric ?? ''}\t${r.cm}\t${r.total ?? ''}`)
      .join('\n');
    void navigator.clipboard?.writeText(`${head}\n${body}`);
    setMsg('Matrix copied to clipboard.');
  }

  function downloadTemplate() {
    downloadCsv(
      `cost-cm-${cost.product_code}.csv`,
      ['size', 'cm'],
      SIZES.map((s) => [s, cmBySize[s] ?? '']),
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
    const sizeSet = new Set<string>(SIZES);
    const patch: Record<string, string> = {};
    let bad = 0;
    for (const r of objects) {
      const size = String(r.size ?? '').trim().toUpperCase();
      const cm = String(r.cm ?? r.cm_cost ?? '').trim();
      if (!sizeSet.has(size)) { bad += 1; continue; }
      if (cm !== '') patch[size] = cm;
    }
    if (!Object.keys(patch).length) {
      setErr('No matching sizes imported. Expected headers: size, cm.');
      return;
    }
    setCmBySize((cur) => ({ ...cur, ...patch }));
    setMsg(`Imported CMTP for ${Object.keys(patch).length} size(s)${bad ? `, skipped ${bad}` : ''}. Review, then Save.`);
  }

  function saveDetail() {
    setErr(null);
    setMsg(null);
    const header = new FormData();
    header.set('product_code', cost.product_code);
    header.set('job_cost', cost.job_cost?.toString() ?? '');
    header.set('fob_cost', cost.fob_cost?.toString() ?? '');
    header.set('efob_cost', cost.efob_cost?.toString() ?? '');
    // Note: cm_cost is owned by the CMTP breakdown, not the matrix — not sent here.
    header.set('total_po_avg_cost', total);
    header.set('cad_link', cad);
    header.set('rfp_link', rfp);
    header.set('fabric_code', fabricCode);

    const detail = new FormData();
    detail.set('product_code', cost.product_code);
    detail.set(
      'lines',
      JSON.stringify(
        matrix
          .filter((r) => r.has)
          .map((r) => ({
            colour: '',
            size: r.size,
            fabric_cost: r.fabric != null ? String(r.fabric) : '',
            cm_cost: r.cm,
            total_cost: r.total != null ? String(r.total) : '',
          })),
      ),
    );

    start(async () => {
      const h = await saveStandardCost(header);
      if (!h.ok) return setErr(h.error);
      const d = await saveStandardCostLines(detail);
      if (!d.ok) return setErr(d.error);
      reloadWithToast();
    });
  }

  const rw = editable && view !== 'document';

  return (
    <div className="wf-cost-detail">
      {err && <Notice tone="error">{err}</Notice>}
      {msg && <Notice tone="ok">{msg}</Notice>}

      <div className="wf-cost-detail-head">
        <div className="segment wf-segment">
          <button type="button" className={view === 'cmtp' ? 'active' : ''} onClick={() => setView('cmtp')}>CMTP</button>
          <button type="button" className={view === 'matrix' ? 'active' : ''} onClick={() => setView('matrix')}>Matrix</button>
          <button type="button" className={view === 'document' ? 'active' : ''} onClick={() => setView('document')}>Document</button>
          <button type="button" className={view === 'more' ? 'active' : ''} onClick={() => setView('more')}>View more</button>
        </div>
        {view === 'matrix' && (
          <div className="wf-toolbar-right">
            <label className="wf-inline-field">
              Fabric
              <select value={fabricCode} disabled={!rw} onChange={(e) => setFabricCode(e.target.value)}>
                <option value="">—</option>
                {fabricCodes.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </label>
            <span className="wf-subtle">
              Fabric rate {fabricRate != null ? fabricRate : '— (set in Fabric Cost)'}
            </span>
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
            {rw && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadTemplate}>
                <Download size={13} /> Template
              </button>
            )}
            {rw && (
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => fileRef.current?.click()}>
                <Upload size={13} /> Import CSV
              </button>
            )}
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={copyMatrix}>Copy</button>
          </div>
        )}
      </div>

      {view === 'cmtp' ? (
        <CmtpBreakdown cost={cost} cmtp={cmtp} editable={editable} />
      ) : view === 'document' ? (
        <div className="wf-cost-doc">
          <h3>Cost sheet — {cost.product_code}</h3>
          <dl className="wf-doc-meta">
            <div><dt>Fabric</dt><dd>{fabricCode || '—'}</dd></div>
            <div><dt>Fabric rate</dt><dd>{fabricRate ?? '—'}</dd></div>
            <div><dt>Size-wise avg</dt><dd>{sizeAvg ?? '—'}</dd></div>
            <div><dt>Total PO avg</dt><dd>{total || '—'}</dd></div>
          </dl>
          <table className="wf-grid wf-cost-lines">
            <thead><tr><th>Size</th><th className="num">Fabric</th><th className="num">CMTP</th><th className="num">Total</th></tr></thead>
            <tbody>
              {filled.map((r) => (
                <tr key={r.size}><td>{r.size}</td><td className="num">{r.fabric ?? '—'}</td><td className="num">{r.cm}</td><td className="num">{r.total ?? '—'}</td></tr>
              ))}
              {!filled.length && <tr><td colSpan={4} className="wf-empty-cell">No costed sizes yet.</td></tr>}
            </tbody>
            {filled.length > 0 && (
              <tfoot><tr><td colSpan={3}>Size-wise average</td><td className="num strong">{sizeAvg}</td></tr></tfoot>
            )}
          </table>
          {(cad || rfp) && (
            <p className="wf-subtle">
              {cad && <>CAD: <a href={cad}>{cad}</a> </>}
              {rfp && <>· RFP: <a href={rfp}>{rfp}</a></>}
            </p>
          )}
        </div>
      ) : (
        <>
          {view === 'more' && (
            <div className="wf-form-grid">
              <label className="field wf-field">
                <span>Fabric<small>rate pulled from Fabric Cost</small></span>
                <select value={fabricCode} disabled={!rw} onChange={(e) => setFabricCode(e.target.value)}>
                  <option value="">—</option>
                  {fabricCodes.map((f) => (<option key={f} value={f}>{f}</option>))}
                </select>
              </label>
              <Field label="Total PO average cost" hint="entered directly">
                <input type="number" min={0} value={total} disabled={!rw} onChange={(e) => setTotal(e.target.value)} />
              </Field>
              <Field label="CAD link">
                <input value={cad} disabled={!rw} placeholder="https://…" onChange={(e) => setCad(e.target.value)} />
              </Field>
              <Field label="RFP link">
                <input value={rfp} disabled={!rw} placeholder="https://…" onChange={(e) => setRfp(e.target.value)} />
              </Field>
            </div>
          )}

          <table className="wf-grid wf-cost-lines wf-cost-matrix">
            <thead>
              <tr>
                <th>Size</th>
                <th className="num wf-cell-calc">Fabric*</th>
                <th className="num input-col wf-cell-input">CMTP</th>
                <th className="num wf-cell-calc">Total*</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((r, i) => (
                <tr key={r.size}>
                  <td className="strong">{r.size}</td>
                  <td className="num wf-cell-calc">{r.fabric ?? '—'}</td>
                  <td className="num input-col wf-cell-input">
                    <input
                      type="number"
                      min={0}
                      value={r.cm}
                      disabled={!rw}
                      onChange={(e) => setCm(r.size, e.target.value)}
                      onPaste={(e) => rw && onCmPaste(e, i)}
                    />
                  </td>
                  <td className="num wf-cell-calc">{r.total ?? '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Size-wise average*</td>
                <td className="num strong wf-cell-calc">{sizeAvg ?? '—'}</td>
              </tr>
            </tfoot>
          </table>
          <p className="wf-subtle wf-legend">
            <span className="wf-legend-input">input</span>
            <span className="wf-legend-calc">computed</span>
            — the <strong>computed</strong> (green) cells fill themselves: fabric is pulled from the
            Fabric Cost sheet, total = fabric + CMTP. Paste a CMTP column straight from Excel.
          </p>

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={saveDetail} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save cost sheet'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

type CmtpRow = { uid: number; category: string; label: string; amount: string };

// Monotonic client-only key source for CMTP rows (stable across add/remove).
let cmtpUidSeq = 0;
const nextCmtpUid = () => (cmtpUidSeq += 1);

/**
 * CMTP cost breakdown — the CM cost built from category heads (§1 of the spec).
 * The 6 core heads always render; the team adds line items (sub-tabs) under any
 * head, and can add custom heads ad hoc. The sum of all amounts is the CM cost,
 * saved onto the product's standard-cost row.
 */
function CmtpBreakdown({
  cost,
  cmtp,
  editable,
}: {
  cost: StandardCost;
  cmtp: CmtpComponent[];
  editable: boolean;
}) {
  const [rows, setRows] = useState<CmtpRow[]>(() =>
    cmtp.length
      ? cmtp.map((c) => ({
          uid: nextCmtpUid(),
          category: c.category,
          label: c.label ?? '',
          amount: c.amount != null ? String(c.amount) : '',
        }))
      : // No breakdown yet — seed the mandatory heads with one blank line each.
        CMTP_HEADS.map((h) => ({ uid: nextCmtpUid(), category: h.key, label: '', amount: '' })),
  );
  const [newHead, setNewHead] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Head order: the 6 mandatory heads first, then any custom heads present.
  const categories = useMemo(() => {
    const order = [...CMTP_MANDATORY];
    for (const r of rows) if (!order.includes(r.category)) order.push(r.category);
    return order;
  }, [rows]);

  const total = rows.reduce((s, r) => s + (numv(r.amount) || 0), 0);

  const addRow = (category: string, label = '') =>
    setRows((cur) => [...cur, { uid: nextCmtpUid(), category, label, amount: '' }]);
  const removeRow = (u: number) => setRows((cur) => cur.filter((r) => r.uid !== u));
  const patchRow = (u: number, key: 'label' | 'amount', value: string) =>
    setRows((cur) => cur.map((r) => (r.uid === u ? { ...r, [key]: value } : r)));

  function addHead() {
    const c = newHead.trim();
    if (c && !rows.some((r) => r.category === c)) addRow(c);
    setNewHead('');
  }

  function save() {
    setErr(null);
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set(
      'components',
      JSON.stringify(rows.map((r) => ({ category: r.category, label: r.label, amount: r.amount }))),
    );
    start(async () => {
      const res = await saveCmtpComponents(fd);
      if (res.ok) reloadWithToast();
      else setErr(res.error);
    });
  }

  return (
    <div className="wf-cmtp">
      {err && <Notice tone="error">{err}</Notice>}
      <p className="wf-subtle">
        CMTP cost is built from these heads — the total below is the product&rsquo;s FINAL CMTP. The
        core heads are mandatory; add lines under a head, or a whole head, as the product needs
        (e.g. buttoning under Product Trims for shirts).
      </p>

      {categories.map((cat) => {
        const head = CMTP_HEADS.find((h) => h.key === cat);
        const catRows = rows.filter((r) => r.category === cat);
        const sub = catRows.reduce((s, r) => s + (numv(r.amount) || 0), 0);
        const mandatory = CMTP_MANDATORY.includes(cat);
        return (
          <div key={cat} className="wf-cmtp-head">
            <div className="wf-cmtp-head-row">
              <span className="wf-cmtp-head-name">
                {head?.label ?? cat}
                {mandatory && <small className="wf-subtle"> · required</small>}
              </span>
              <span className="wf-cmtp-sub wf-cell-calc">{sub || '—'}</span>
            </div>
            {catRows.map((r) => (
              <div key={r.uid} className="wf-cmtp-line">
                <input
                  className="wf-cmtp-label"
                  placeholder="sub-item (optional)"
                  value={r.label}
                  disabled={!editable}
                  onChange={(e) => patchRow(r.uid, 'label', e.target.value)}
                />
                <input
                  className="wf-cmtp-amt"
                  type="number"
                  min={0}
                  placeholder="amount"
                  value={r.amount}
                  disabled={!editable}
                  onChange={(e) => patchRow(r.uid, 'amount', e.target.value)}
                />
                {editable && (
                  <button
                    type="button"
                    className="wf-icon-btn"
                    aria-label="Remove line"
                    onClick={() => removeRow(r.uid)}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            ))}
            {editable && (
              <div className="wf-cmtp-add">
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => addRow(cat)}>
                  <Plus size={12} /> Add line
                </button>
                {head?.suggest?.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="wf-chip-btn"
                    disabled={catRows.some((r) => r.label === s)}
                    onClick={() => addRow(cat, s)}
                  >
                    + {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {editable && (
        <div className="wf-cmtp-newhead">
          <input
            placeholder="Add a head (e.g. Embroidery)"
            value={newHead}
            onChange={(e) => setNewHead(e.target.value)}
          />
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            disabled={!newHead.trim()}
            onClick={addHead}
          >
            <Plus size={12} /> Add head
          </button>
        </div>
      )}

      <div className="wf-cmtp-total">
        <span>FINAL CMTP cost</span>
        <strong className="wf-cell-calc">{total || '—'}</strong>
      </div>

      {editable && (
        <div className="wf-cost-detail-foot">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Save CMTP breakdown'}
          </button>
        </div>
      )}
    </div>
  );
}
