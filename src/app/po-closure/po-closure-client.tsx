'use client';

import { Fragment, useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { ChevronDown, ChevronRight, Play, Save } from 'lucide-react';
import { initiateClosure, submitFinanceLeg, submitSourcingLeg } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import type { CuttingRegister, PoClosureView } from '@/lib/forms/types';

const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');
const disp = (v: number | null) => (v == null ? '—' : String(v));
const legLabel = (c: PoClosureView) =>
  c.compliance.leg === 'closed' ? 'Closed' : c.compliance.leg === 'finance' ? 'Finance pending' : 'Sourcing pending';

// A breach's responsible party: whoever owns the currently-late leg.
const owner = (c: PoClosureView) =>
  c.compliance.leg === 'finance' ? c.sourcing_submitted_by ?? '—' : c.initiated_by ?? 'unassigned';

export function PoClosureClient({
  closures,
  cutting,
  editable,
}: {
  closures: PoClosureView[];
  cutting: CuttingRegister[];
  editable: boolean;
}) {
  const [filter, setFilter] = useState<'all' | 'open15'>('all');
  const [expanded, setExpanded] = useState<number | null>(null);

  const cuttingByPo = useMemo(() => {
    const m = new Map<string, CuttingRegister[]>();
    for (const c of cutting) m.set(c.po_ref_num, [...(m.get(c.po_ref_num) ?? []), c]);
    return m;
  }, [cutting]);

  const stats = useMemo(() => {
    let open = 0, breached = 0, amber = 0, closed = 0;
    for (const c of closures) {
      if (c.closed_at) closed += 1; else open += 1;
      if (c.compliance.rag === 'red') breached += 1;
      else if (c.compliance.rag === 'amber') amber += 1;
    }
    return { open, breached, amber, closed };
  }, [closures]);

  // Per-person breach breakdown (spec §5 — enforcement).
  const byOwner = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of closures) {
      if (c.compliance.rag !== 'red') continue;
      const k = owner(c);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [closures]);

  const shown = filter === 'open15'
    ? closures.filter((c) => !c.closed_at && (c.compliance.totalDays ?? 0) > 15)
    : closures;

  return (
    <>
      <div className="wf-metric-row">
        <Metric label="Open" value={stats.open} />
        <Metric label="Breached (>15d)" value={stats.breached} tone="red" />
        <Metric label="Approaching (5-7d)" value={stats.amber} tone="amber" />
        <Metric label="Closed" value={stats.closed} />
      </div>

      {byOwner.length > 0 && (
        <div className="wf-card">
          <div className="wf-card-title">Breaches by responsible person</div>
          <div className="wf-owner-row">
            {byOwner.map(([who, n]) => (
              <span key={who} className="wf-owner-chip">{who} <strong>{n}</strong></span>
            ))}
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <div className="segment wf-segment">
          <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button>
          <button type="button" className={filter === 'open15' ? 'active' : ''} onClick={() => setFilter('open15')}>Open beyond 15 days</button>
        </div>
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th aria-label="SLA" />
                <th>PO</th><th>Product</th><th>Completed</th><th className="num">Days open</th>
                <th>Stage</th><th className="num">Surplus</th><th aria-label="expand" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <Fragment key={c.id}>
                  <tr className={expanded === c.id ? 'wf-cost-row-open' : undefined}>
                    <td><span className={`wf-rag wf-rag-${c.compliance.rag}`} title={c.compliance.status} /></td>
                    <td className="mono">{c.po_ref_num}</td>
                    <td>{c.productCode ?? '—'}</td>
                    <td>{fmtDate(c.easycom_completed_at)}</td>
                    <td className={`num${c.compliance.rag === 'red' ? ' wf-error-text' : ''}`}>{c.compliance.totalDays ?? '—'}</td>
                    <td><span className="wf-status">{legLabel(c)}</span></td>
                    <td className="num">{c.surplus_fabric_value != null ? `₹${c.surplus_fabric_value}` : disp(c.surplus_fabric_qty)}</td>
                    <td>
                      <button type="button" className="wf-expand-btn" aria-expanded={expanded === c.id} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                        {expanded === c.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </td>
                  </tr>
                  {expanded === c.id && (
                    <tr className="wf-cost-detail-row">
                      <td colSpan={8}>
                        <ClosureDetail closure={c} registers={cuttingByPo.get(c.po_ref_num) ?? []} editable={editable} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!shown.length && <tr><td colSpan={8} className="wf-empty-cell">No PO closures in the window.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone?: 'red' | 'amber' }) {
  return (
    <div className={`wf-metric${tone ? ' wf-metric-' + tone : ''}`}>
      <span className="wf-metric-value">{value}</span>
      <span className="wf-metric-label">{label}</span>
    </div>
  );
}

function ClosureDetail({
  closure: c,
  registers,
  editable,
}: {
  closure: PoClosureView;
  registers: CuttingRegister[];
  editable: boolean;
}) {
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  // Sourcing leg
  const [ref, setRef] = useState<string>(c.cutting_register_ref ? String(c.cutting_register_ref) : '');
  // Finance leg (surplus value pre-filled, overridable)
  const [surplusVal, setSurplusVal] = useState(c.surplus_fabric_value?.toString() ?? '');
  const [challan, setChallan] = useState(c.challan_number ?? '');
  const [dn, setDn] = useState(c.debit_note_number ?? '');
  const [dnVal, setDnVal] = useState(c.debit_note_value?.toString() ?? '');
  const [remarks, setRemarks] = useState(c.finance_remarks ?? '');

  function act(fn: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, extra: Record<string, string>) {
    setErr(null);
    const fd = new FormData();
    fd.set('id', String(c.id));
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await fn(fd);
      if (res.ok) reloadWithToast();
      else setErr(res.error ?? 'Failed.');
    });
  }

  const sourcingDone = c.sourcing_status === 'submitted';
  const financeDone = c.finance_status === 'submitted';

  return (
    <div className="wf-cost-detail">
      {err && <Notice tone="error">{err}</Notice>}

      {!c.closure_initiated_at && editable && (
        <div className="wf-issue-row">
          <span className="wf-subtle">Completed {fmtDate(c.easycom_completed_at)} — start the closure.</span>
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={() => act(initiateClosure, {})}>
            <Play size={13} /> Initiate closure
          </button>
        </div>
      )}

      {/* Sourcing leg */}
      <div className="wf-leg">
        <span className="wf-cost-param-head">1 · Sourcing {sourcingDone && <span className="wf-tag-approved">✓ {fmtDate(c.sourcing_submitted_at)}</span>}</span>
        {!sourcingDone && editable ? (
          <div className="wf-form-grid">
            <label className="field wf-field">
              <span>Cutting register<small>links the actual consumption</small></span>
              <select value={ref} onChange={(e) => setRef(e.target.value)}>
                <option value="">—</option>
                {registers.map((r) => (
                  <option key={r.id} value={r.id}>
                    {fmtDate(r.cutting_date)} · actual {disp(r.actual_consumption_qty)} vs BOM {disp(r.bom_standard_qty)}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy || !c.closure_initiated_at} onClick={() => act(submitSourcingLeg, { cutting_register_ref: ref })}>
              <Save size={13} /> Submit sourcing
            </button>
            {registers.length === 0 && <span className="wf-subtle">No cutting entries for this PO yet — add one on the Cutting Register page.</span>}
          </div>
        ) : (
          <dl className="wf-doc-meta">
            <div><dt>Surplus qty</dt><dd>{disp(c.surplus_fabric_qty)}</dd></div>
            <div><dt>Surplus value</dt><dd>{c.surplus_fabric_value != null ? `₹${c.surplus_fabric_value}` : '—'}</dd></div>
          </dl>
        )}
      </div>

      {/* Finance leg */}
      <div className="wf-leg">
        <span className="wf-cost-param-head">2 · Finance {financeDone && <span className="wf-tag-approved">✓ {fmtDate(c.finance_submitted_at)}</span>}</span>
        {sourcingDone && !financeDone && editable ? (
          <div className="wf-form-grid">
            <Field label="Surplus fabric value" hint="auto-computed — override if needed">
              <input type="number" value={surplusVal} onChange={(e) => setSurplusVal(e.target.value)} />
            </Field>
            <Field label="Challan number"><input value={challan} onChange={(e) => setChallan(e.target.value)} /></Field>
            <Field label="Debit note number"><input value={dn} onChange={(e) => setDn(e.target.value)} /></Field>
            <Field label="Debit note value"><input type="number" value={dnVal} onChange={(e) => setDnVal(e.target.value)} /></Field>
            <Field label="Remarks"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} /></Field>
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={busy}
              onClick={() => act(submitFinanceLeg, {
                surplus_fabric_value: surplusVal,
                challan_number: challan,
                debit_note_number: dn,
                debit_note_value: dnVal,
                finance_remarks: remarks,
              })}
            >
              <Save size={13} /> Close PO
            </button>
          </div>
        ) : financeDone ? (
          <dl className="wf-doc-meta">
            <div><dt>Challan</dt><dd>{c.challan_number ?? '—'}</dd></div>
            <div><dt>Debit note</dt><dd>{c.debit_note_number ?? '—'}{c.debit_note_value != null ? ` · ₹${c.debit_note_value}` : ''}</dd></div>
            <div><dt>Closed</dt><dd>{fmtDate(c.closed_at)} · {c.compliance.status === 'breached' ? 'breached' : 'on time'}</dd></div>
          </dl>
        ) : (
          <span className="wf-subtle">Waiting on the sourcing leg.</span>
        )}
      </div>
    </div>
  );
}
