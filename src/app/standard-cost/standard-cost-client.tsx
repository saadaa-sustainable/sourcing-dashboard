'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { ChevronDown, ChevronRight, Lock, Plus, Save, Trash2 } from 'lucide-react';
import {
  acceptProposedCost,
  confirmCmRate,
  confirmFabricRate,
  proposeCost,
  addCmtpSubitem,
  rejectCost,
  renegotiateCost,
  saveCmtpComponents,
  saveCostStandards,
  saveEfobFabricCost,
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
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
  isAdminTurn,
  isTeamTurn,
  nextActor,
} from '@/lib/forms/cost';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import type {
  CmtpComponent,
  CostStandards,
  EfobFabricCost,
  ProductCatalogItem,
  SdRole,
  StandardCost,
  StandardCostLine,
  StandardCostRateHistory,
} from '@/lib/forms/types';
import type { CmtpRevision } from '@/lib/standard-cost-revisions.server';

const disp = (v: number | null) => (v == null ? '—' : String(v));

/** Read-only fabric buildup referenced from the Fabric Cost master. */
type FabricBuildup = { grey: number | null; processing: number | null; finished: number | null };

export function StandardCostClient({
  costs,
  lines = [],
  cmtp = [],
  cmtpSubitems = {},
  fabricBase = {},
  fabricCodes = [],
  standards,
  efob = [],
  catalog = [],
  rateHistory = {},
  cmtpRevisions = {},
  initialOpen = null,
  role,
  track = 'fg',
}: {
  costs: StandardCost[];
  lines?: StandardCostLine[];
  cmtp?: CmtpComponent[];
  cmtpSubitems?: Record<string, string[]>;
  fabricBase?: Record<string, FabricBuildup>;
  fabricCodes?: string[];
  standards?: CostStandards;
  efob?: EfobFabricCost[];
  catalog?: ProductCatalogItem[];
  rateHistory?: Record<string, StandardCostRateHistory[]>;
  cmtpRevisions?: Record<string, CmtpRevision[]>;
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

  // Rows waiting on the signed-in user's side of the negotiation.
  const [mineOnly, setMineOnly] = useState(false);
  const myTurn = useMemo(
    () => (role === 'admin' ? isAdminTurn : isTeamTurn),
    [role],
  );
  const awaitingCount = useMemo(
    () => costs.filter((c) => myTurn(c.neg_stage)).length,
    [costs, myTurn],
  );

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const base = mineOnly ? costs.filter((c) => myTurn(c.neg_stage)) : costs;
    return q ? base.filter((c) => c.product_code.toLowerCase().includes(q)) : base;
  }, [costs, filter, mineOnly, myTurn]);

  const existingCodes = useMemo(() => new Set(costs.map((c) => c.product_code)), [costs]);

  function addCode(codeRaw: string) {
    const code = codeRaw.trim();
    if (!code) {
      setError(`Enter a ${codeLabel.toLowerCase()}.`);
      return;
    }
    setError(null);
    setMessage(null);
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
        applies) → Mahesh <strong>accepts the proposal as-is</strong>, <strong>rejects</strong> it, or
        sets a <strong>target</strong> → team returns with the <strong>actual vendor rate</strong> →
        Mahesh <strong>signs off</strong>, and that becomes the Standard Cost the Buying Plan values
        from. {signedOff} of {costs.length} {isMat ? 'materials' : 'products'} are signed off.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {!isMat && standards && <StandardFieldsPanel standards={standards} editable={editable} />}
      {!isMat && <EfobFabricCostPanel rows={efob} editable={editable} />}

      {editable && (
        <div className="wf-form-panel">
          {isMat ? (
            <div className="wf-form-grid">
              <Field label={`Add a ${codeLabel.toLowerCase()}`} hint="seeds a row you can then propose">
                <input
                  value={newCode}
                  placeholder="e.g. TRM07"
                  onChange={(e) => setNewCode(e.target.value)}
                />
              </Field>
              <button type="button" className="wf-btn wf-btn-primary" onClick={() => addCode(newCode)} disabled={pending}>
                <Plus size={15} /> Add to sheet
              </button>
            </div>
          ) : (
            <Field label="Add a product" hint="search by code or name — from the product master">
              <ProductPicker
                items={catalog}
                exclude={existingCodes}
                onPick={(code) => addCode(code)}
                disabled={pending}
                placeholder="Search product code or name…"
              />
            </Field>
          )}
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {awaitingCount > 0 && (
          <button
            type="button"
            className={`wf-btn wf-btn-sm ${mineOnly ? 'wf-btn-primary' : 'wf-btn-ghost'}`}
            onClick={() => setMineOnly((v) => !v)}
            title="Show only rows waiting on you"
          >
            {awaitingCount} awaiting your action
          </button>
        )}
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
                          cmtpSubitems={cmtpSubitems}
                          fabricBase={fabricBase}
                          fabricCodes={fabricCodes}
                          history={rateHistory[cost.product_code] ?? []}
                          revisions={cmtpRevisions[cost.product_code] ?? []}
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

/**
 * EFOB Fabric Cost (spec §6) — the monthly fixed rate the company sets for carrying
 * commodity risk on EFOB POs. Its own benchmark, separate from the fabric-cost sheet.
 */
function EfobFabricCostPanel({ rows, editable }: { rows: EfobFabricCost[]; editable: boolean }) {
  const thisMonth = rows[0]?.month?.slice(0, 7) ?? '';
  const [month, setMonth] = useState('');
  const [rate, setRate] = useState('');
  const [busy, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function save() {
    setMsg(null);
    setErr(null);
    if (!month) return setErr('Pick a month.');
    if (rate === '') return setErr('Enter the rate.');
    const fd = new FormData();
    fd.set('month', month);
    fd.set('rate', rate);
    start(async () => {
      const res = await saveEfobFabricCost(fd);
      if (res.ok) reloadWithToast();
      else setErr(res.error);
    });
  }

  return (
    <details className="wf-standards-panel">
      <summary>
        EFOB Fabric Cost — the monthly rate for EFOB POs
        {rows[0]?.rate != null && (
          <span className="wf-subtle"> · {thisMonth}: ₹{rows[0].rate}</span>
        )}
      </summary>
      {msg && <Notice tone="ok">{msg}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
      {editable && (
        <div className="wf-form-grid">
          <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></Field>
          <Field label="EFOB fabric rate"><input type="number" min={0} value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
            <Save size={13} /> {busy ? 'Saving…' : 'Set rate'}
          </button>
        </div>
      )}
      {rows.length > 0 && (
        <table className="wf-grid wf-cost-lines">
          <thead><tr><th>Month</th><th className="num">Rate</th><th>Set by</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.month}>
                <td>{r.month.slice(0, 7)}</td>
                <td className="num">{r.rate != null ? `₹${r.rate}` : '—'}</td>
                <td className="wf-subtle">{r.updated_by ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!rows.length && <p className="wf-subtle">No EFOB fabric rate set yet.</p>}
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
            <div className="wf-issue-row wf-issue-row-wrap">
              {canAcceptProposal(role, stage) && (
                <button
                  type="button"
                  className="wf-btn wf-btn-primary wf-btn-sm"
                  disabled={busy}
                  title="Approve the proposed rates as-is — they become the standard cost"
                  onClick={() => act(acceptProposedCost, {})}
                >
                  Accept proposal
                </button>
              )}
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
                className="wf-btn wf-btn-ghost wf-btn-sm"
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

// FINAL PRICE buildup (matches the live cost sheet): on the total garment cost,
// REJ and OH each add min(5%, ₹10), then MARGIN adds 15% on the subtotal.
const REJ_PCT = 0.05;
const OH_PCT = 0.05;
const MARGIN_PCT = 0.15;
const RO_CAP = 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
function buildFinal(garment: number) {
  const rej = Math.min(garment * REJ_PCT, RO_CAP);
  const oh = Math.min(garment * OH_PCT, RO_CAP);
  const sub = garment + rej + oh;
  const margin = sub * MARGIN_PCT;
  return { rej, oh, margin, final: sub + margin };
}

/**
 * The expandable cost record — the two linked standards that concatenate into the
 * final cost, each independently owned:
 *   • Fabric Cost — referenced read-only from the Fabric Cost master (Vikram ji);
 *     per-size fabric cost = finished-fabric rate × consumption(size).
 *   • CMTP — the CMTP breakdown tab (Nimisha / Durganshu).
 * Final Cost = Fabric + CMTP → REJ / OH / MARGIN → FINAL PRICE, all computed and
 * never directly editable.
 */
function CostDetail({
  cost,
  lines,
  cmtp,
  cmtpSubitems,
  fabricBase,
  fabricCodes,
  history,
  revisions,
  editable,
}: {
  cost: StandardCost;
  lines: StandardCostLine[];
  cmtp: CmtpComponent[];
  cmtpSubitems: Record<string, string[]>;
  fabricBase: Record<string, FabricBuildup>;
  fabricCodes: string[];
  history: StandardCostRateHistory[];
  revisions: CmtpRevision[];
  editable: boolean;
}) {
  const [view, setView] = useState<'cmtp' | 'fabric' | 'final' | 'history'>('cmtp');
  const [fabricCode, setFabricCode] = useState(cost.fabric_code ?? '');
  const [consBySize, setConsBySize] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const l of lines) {
      if (l.size && l.consumption != null) m[l.size.toUpperCase()] = String(l.consumption);
    }
    return m;
  });
  const [cad, setCad] = useState(cost.cad_link ?? '');
  const [rfp, setRfp] = useState(cost.rfp_link ?? '');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const fab = fabricCode ? fabricBase[fabricCode] : undefined;
  const fabricRate = fab?.finished ?? null;
  const cmtpTotal = cost.cm_cost; // FINAL CMTP owned by the CMTP tab

  // Per-size buildup: fabric = rate × consumption; garment = fabric + CMTP; then
  // the FINAL PRICE chain.
  const rows = SIZES.map((size) => {
    const cons = consBySize[size] ?? '';
    const has = cons !== '';
    const fabric = has && fabricRate != null ? r2(fabricRate * numv(cons)) : null;
    const garment = fabric != null && cmtpTotal != null ? r2(fabric + cmtpTotal) : null;
    const f = garment != null ? buildFinal(garment) : null;
    return {
      size,
      cons,
      has,
      fabric,
      garment,
      rej: f ? r2(f.rej) : null,
      oh: f ? r2(f.oh) : null,
      margin: f ? r2(f.margin) : null,
      final: f ? r2(f.final) : null,
    };
  });
  const filled = rows.filter((r) => r.has);
  const poAvgFinal =
    filled.length && filled.every((r) => r.final != null)
      ? r2(filled.reduce((s, r) => s + (r.final ?? 0), 0) / filled.length)
      : null;

  function setCons(size: string, value: string) {
    setConsBySize((cur) => ({ ...cur, [size]: value }));
  }

  // Both the Fabric and Final tabs persist the same record (fabric link, per-size
  // consumption, doc links, and the computed PO-average final price).
  function save() {
    setErr(null);
    const header = new FormData();
    header.set('product_code', cost.product_code);
    header.set('fabric_code', fabricCode);
    header.set('cad_link', cad);
    header.set('rfp_link', rfp);
    if (poAvgFinal != null) header.set('total_po_avg_cost', String(poAvgFinal));

    const detail = new FormData();
    detail.set('product_code', cost.product_code);
    detail.set(
      'lines',
      JSON.stringify(
        filled.map((r) => ({
          colour: '',
          size: r.size,
          consumption: r.cons,
          fabric_cost: r.fabric != null ? String(r.fabric) : '',
          total_cost: r.garment != null ? String(r.garment) : '',
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

  return (
    <div className="wf-cost-detail">
      {err && <Notice tone="error">{err}</Notice>}

      <div className="wf-cost-detail-head">
        <div className="segment wf-segment">
          <button type="button" className={view === 'cmtp' ? 'active' : ''} onClick={() => setView('cmtp')}>CMTP</button>
          <button type="button" className={view === 'fabric' ? 'active' : ''} onClick={() => setView('fabric')}>Fabric Cost</button>
          <button type="button" className={view === 'final' ? 'active' : ''} onClick={() => setView('final')}>Final Cost</button>
          <button type="button" className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>
            Rate History{history.length > 0 ? ` (${history.length})` : ''}
          </button>
        </div>
        <span className="wf-subtle wf-two-entity-note">
          Final = Fabric + CMTP (computed). Two owners: Fabric — Vikram ji · CMTP — Nimisha / Durganshu.
        </span>
      </div>

      {view === 'cmtp' ? (
        <CmtpBreakdown cost={cost} cmtp={cmtp} subitems={cmtpSubitems} editable={editable} />
      ) : view === 'fabric' ? (
        <div className="wf-fabric-view">
          <div className="wf-form-grid">
            <label className="field wf-field">
              <span>Fabric<small>the fabric this product uses</small></span>
              <select value={fabricCode} disabled={!editable} onChange={(e) => setFabricCode(e.target.value)}>
                <option value="">—</option>
                {fabricCodes.map((f) => (<option key={f} value={f}>{f}</option>))}
              </select>
            </label>
          </div>

          <div className="wf-cost-param">
            <span className="wf-cost-param-head">Fabric Cost — owned by the Fabric Cost master (Vikram ji)</span>
            <dl className="wf-doc-meta">
              <div><dt>Grey rate</dt><dd className="wf-cell-input">{disp(fab?.grey ?? null)}</dd></div>
              <div><dt>Processing</dt><dd className="wf-cell-input">{disp(fab?.processing ?? null)}</dd></div>
              <div><dt>Finished fabric (INR/mtr)</dt><dd className="wf-cell-calc">{disp(fab?.finished ?? null)}</dd></div>
            </dl>
            <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/fabric-cost">Edit on Fabric Cost →</a>
          </div>

          <table className="wf-grid wf-cost-lines wf-cost-matrix">
            <thead>
              <tr>
                <th>Size</th>
                <th className="num input-col wf-cell-input">Consumption (mtr)</th>
                <th className="num wf-cell-calc">Fabric cost*</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.size}>
                  <td className="strong">{r.size}</td>
                  <td className="num input-col wf-cell-input">
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={r.cons}
                      disabled={!editable}
                      onChange={(e) => setCons(r.size, e.target.value)}
                    />
                  </td>
                  <td className="num wf-cell-calc">{disp(r.fabric)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="wf-subtle wf-legend">
            <span className="wf-legend-input">input</span>
            <span className="wf-legend-calc">computed</span>
            — fabric cost = finished-fabric rate × consumption. The rate is owned by the Fabric Cost master.
            {fabricRate == null && ' Pick a fabric with a finished rate to compute.'}
          </p>

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save fabric cost'}
              </button>
            </div>
          )}
        </div>
      ) : view === 'final' ? (
        <div className="wf-final-view">
          <div className="table-scroll">
            <table className="wf-grid wf-cost-lines">
              <thead>
                <tr>
                  <th>Size</th>
                  <th className="num wf-cell-calc">Fabric</th>
                  <th className="num wf-cell-calc">CMTP</th>
                  <th className="num wf-cell-calc">Garment</th>
                  <th className="num wf-cell-calc">REJ</th>
                  <th className="num wf-cell-calc">OH</th>
                  <th className="num wf-cell-calc">Margin</th>
                  <th className="num wf-cell-calc">Final price</th>
                </tr>
              </thead>
              <tbody>
                {filled.map((r) => (
                  <tr key={r.size}>
                    <td className="strong">{r.size}</td>
                    <td className="num wf-cell-calc">{disp(r.fabric)}</td>
                    <td className="num wf-cell-calc">{disp(cmtpTotal)}</td>
                    <td className="num wf-cell-calc">{disp(r.garment)}</td>
                    <td className="num wf-cell-calc">{disp(r.rej)}</td>
                    <td className="num wf-cell-calc">{disp(r.oh)}</td>
                    <td className="num wf-cell-calc">{disp(r.margin)}</td>
                    <td className="num strong wf-cell-calc">{disp(r.final)}</td>
                  </tr>
                ))}
                {!filled.length && (
                  <tr><td colSpan={8} className="wf-empty-cell">Fill fabric consumption (Fabric Cost tab) + CMTP to compute the final price.</td></tr>
                )}
              </tbody>
              {poAvgFinal != null && (
                <tfoot><tr><td colSpan={7}>PO AVG final price</td><td className="num strong wf-cell-calc">{poAvgFinal}</td></tr></tfoot>
              )}
            </table>
          </div>
          <p className="wf-subtle">
            Final price = Garment (Fabric + CMTP) + REJ (5% or ₹10, lower) + OH (5% or ₹10, lower) + Margin 15%.
            {cmtpTotal == null && ' · CMTP not filled yet — fill the CMTP tab.'}
          </p>

          <div className="wf-form-grid">
            <Field label="CAD link"><input value={cad} disabled={!editable} placeholder="https://…" onChange={(e) => setCad(e.target.value)} /></Field>
            <Field label="RFP link"><input value={rfp} disabled={!editable} placeholder="https://…" onChange={(e) => setRfp(e.target.value)} /></Field>
          </div>

          {editable && (
            <div className="wf-cost-detail-foot">
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={busy}>
                <Save size={13} /> {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <RateHistoryPanel history={history} revisions={revisions} />
      )}
    </div>
  );
}

/**
 * Accepted-rate history for a product: every job / FOB / E-FOB rate that was
 * signed off, newest first, with the date and who accepted it. The top row is
 * the LIVE rate the Buying Plan values from (until a new proposal is accepted).
 */
function RateHistoryPanel({
  history,
  revisions = [],
}: {
  history: StandardCostRateHistory[];
  revisions?: CmtpRevision[];
}) {
  const when = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  const amt = (v: number | null) => (v == null ? '—' : String(v));
  return (
    <div className="wf-history-view">
      <p className="wf-subtle">
        Every accepted rate over time — a cost can be re-proposed and re-accepted. The
        top (latest) row is the <strong>live standard cost</strong> the Buying Plan values
        from; a plan freezes its rate when submitted for approval.
      </p>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Accepted on</th>
                <th className="num">Job</th>
                <th className="num">FOB</th>
                <th className="num">E-FOB</th>
                <th>By</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h, i) => (
                <tr key={h.id} className={i === 0 ? 'wf-row-current' : undefined}>
                  <td>
                    {when(h.accepted_at)}
                    {i === 0 && <span className="wf-tag-approved" style={{ marginLeft: 6 }}>current</span>}
                  </td>
                  <td className="num">{disp(h.job_cost)}</td>
                  <td className="num">{disp(h.fob_cost)}</td>
                  <td className="num">{disp(h.efob_cost)}</td>
                  <td className="wf-subtle">{h.accepted_by ?? '—'}</td>
                  <td className="wf-subtle">{h.note ?? '—'}</td>
                </tr>
              ))}
              {!history.length && (
                <tr><td colSpan={6} className="wf-empty-cell">No accepted rate yet — this product has not been signed off.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Item 2 — line-item CMTP revision log: every single-line change with its
          mandatory reason (old → new), so a karigar-rate or trim-rate move is
          auditable without a whole-sheet re-approval. */}
      <p className="wf-subtle" style={{ marginTop: 18 }}>
        <strong>CMTP line revisions</strong> — individual cost-line changes, newest first, each
        with the reason it was revised.
      </p>
      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Revised on</th>
                <th>Line</th>
                <th className="num">Old</th>
                <th className="num">New</th>
                <th>By</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {revisions.map((rv) => (
                <tr key={rv.id}>
                  <td>{when(rv.revised_at)}</td>
                  <td>{rv.category}{rv.label ? ` · ${rv.label}` : ''}</td>
                  <td className="num">{amt(rv.old_amount)}</td>
                  <td className="num">{amt(rv.new_amount)}</td>
                  <td className="wf-subtle">{rv.revised_by ?? '—'}</td>
                  <td className="wf-subtle">{rv.reason}</td>
                </tr>
              ))}
              {!revisions.length && (
                <tr><td colSpan={6} className="wf-empty-cell">No line revisions yet — the CMTP breakdown has not been changed since it was first entered.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
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
  subitems,
  editable,
}: {
  cost: StandardCost;
  cmtp: CmtpComponent[];
  subitems: Record<string, string[]>;
  editable: boolean;
}) {
  // Local, extendable copy of the sub-item master so a newly-added name appears
  // in every dropdown for its head immediately (the server revalidates too).
  const [subs, setSubs] = useState<Record<string, string[]>>(subitems);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [newSub, setNewSub] = useState('');
  const [subBusy, startSub] = useTransition();

  // Options for a head's dropdown: the master list, plus the row's own legacy
  // free-typed value if it predates the master (so it still shows and can be kept).
  const optionsFor = (cat: string, current: string) => {
    const list = subs[cat] ?? [];
    return current && !list.includes(current) ? [current, ...list] : list;
  };

  function addSubitem(cat: string) {
    const name = newSub.trim();
    if (!name) return;
    const fd = new FormData();
    fd.set('category', cat);
    fd.set('name', name);
    startSub(async () => {
      const res = await addCmtpSubitem(fd);
      if (res.ok) {
        setSubs((cur) => {
          const list = cur[cat] ?? [];
          return list.includes(name) ? cur : { ...cur, [cat]: [...list, name].sort() };
        });
        setNewSub('');
        setAddingFor(null);
      }
    });
  }
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
  // Item 2 — a revision reason is mandatory when an EXISTING breakdown's amounts
  // change (not on first entry). Snapshot the amounts as loaded, keyed by head+sub.
  const [reason, setReason] = useState('');
  const hadData = cmtp.length > 0;
  const initialAmts = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cmtp) m.set(`${c.category} :: ${c.label ?? ''}`, c.amount != null ? String(c.amount) : '');
    return m;
  }, [cmtp]);
  const isRevision = useMemo(() => {
    if (!hadData) return false;
    const now = new Map<string, string>();
    for (const r of rows) {
      if (!r.category || (!r.label && !r.amount)) continue;
      now.set(`${r.category} :: ${r.label}`, r.amount);
    }
    if (now.size !== initialAmts.size) return true;
    for (const [k, v] of now) {
      const old = initialAmts.get(k);
      if (old === undefined) return true;
      if (Math.abs((numv(v) || 0) - (numv(old) || 0)) >= 0.005) return true;
    }
    return false;
  }, [rows, initialAmts, hadData]);

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
    if (isRevision && !reason.trim()) {
      setErr('Enter a reason for this revision — it is logged against the changed line(s) in the rate history.');
      return;
    }
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set(
      'components',
      JSON.stringify(rows.map((r) => ({ category: r.category, label: r.label, amount: r.amount }))),
    );
    if (isRevision) fd.set('revision_reason', reason.trim());
    start(async () => {
      const res = await saveCmtpComponents(fd);
      if (res.ok) {
        setReason('');
        reloadWithToast();
      } else setErr(res.error);
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
                {/* Sub-item is picked from the managed master (per head), not
                    free-typed — so the same sub-item can't get two spellings. */}
                <select
                  className="wf-cmtp-label"
                  value={r.label}
                  disabled={!editable}
                  onChange={(e) => patchRow(r.uid, 'label', e.target.value)}
                >
                  <option value="">— sub-item —</option>
                  {optionsFor(cat, r.label).map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
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
                {addingFor === cat ? (
                  <span className="wf-cmtp-newsub">
                    <input
                      placeholder="New sub-item name"
                      value={newSub}
                      disabled={subBusy}
                      autoFocus
                      onChange={(e) => setNewSub(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); addSubitem(cat); }
                        if (e.key === 'Escape') { setAddingFor(null); setNewSub(''); }
                      }}
                    />
                    <button
                      type="button"
                      className="wf-btn wf-btn-primary wf-btn-sm"
                      disabled={subBusy || !newSub.trim()}
                      onClick={() => addSubitem(cat)}
                    >
                      {subBusy ? 'Adding…' : 'Add to master'}
                    </button>
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      disabled={subBusy}
                      onClick={() => { setAddingFor(null); setNewSub(''); }}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="wf-chip-btn"
                    onClick={() => { setAddingFor(cat); setNewSub(''); }}
                  >
                    <Plus size={12} /> New sub-item
                  </button>
                )}
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

      {editable && isRevision && (
        <label className="field wf-field wf-cmtp-reason">
          <span>
            Reason for this revision <small>required — a line amount changed; logged to the rate history</small>
          </span>
          <input
            type="text"
            placeholder="e.g. karigar rate increased; XYZ dyeing rate revised"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
      )}

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
