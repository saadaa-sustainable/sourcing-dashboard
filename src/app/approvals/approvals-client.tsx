'use client';

import { Fragment, useState, useTransition } from 'react';
import { InfoDot } from '@/components/info-dot';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import Link from 'next/link';
import { CheckCheck, RotateCcw, ShieldCheck } from 'lucide-react';
import { canApprove, ROLE_LABEL, STATUS_LABEL } from '@/lib/forms/approval';
import { approveBuyingPlanLines, reworkLines } from '@/lib/forms/actions';
import { StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { LineRework } from '@/components/forms/line-rework';
import { PlanPivot } from '@/components/forms/plan-pivot';
import { ApprovalContextPanel } from '@/components/forms/approval-context-panel';
import { productCodeFromLineLabel, type ApprovalContext } from '@/lib/approval-context';
import { FilterTable, type Column } from '@/components/filter-table';
import type { ApprovalEntity, ApprovalLogRow, ApprovalQueueItem, SdRole } from '@/lib/forms/types';

// Columns for the approval-history log (read-only decision list) → shared FilterTable.
const LOG_COLS: Column<ApprovalLogRow>[] = [
  { key: 'created_at', label: 'When', accessor: (r) => r.created_at, render: (r) => <span className="wf-subtle">{new Date(r.created_at).toLocaleString('en-IN')}</span> },
  { key: 'record', label: 'Record', accessor: (r) => r.entity_label ?? `${r.entity_type} #${r.entity_id}`, render: (r) => r.entity_label ?? `${r.entity_type} #${r.entity_id}` },
  { key: 'change', label: 'Change', accessor: (r) => STATUS_LABEL[r.to_status], render: (r) => (<>{r.from_status ? STATUS_LABEL[r.from_status] : '—'} → <strong>{STATUS_LABEL[r.to_status]}</strong></>) },
  { key: 'actor_email', label: 'Actor', render: (r) => <span className="wf-subtle">{r.actor_email}</span> },
  { key: 'notes', label: 'Notes', render: (r) => r.notes ?? '—' },
];

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

// Type tabs over the queue — born of the 27 Aug incident where a Standard-Cost
// approval session accidentally approved the buying plan sitting in the same
// list. Scoping the view to one approval type makes "approve everything I see"
// safe. Cost approvals stay on their own pages, so only these types queue here.
const TYPE_TABS: { key: ApprovalEntity; label: string }[] = [
  { key: 'buying_plan', label: 'Buying Plans' },
  { key: 'po_approval', label: 'PO Approvals' },
  { key: 'po_delete', label: 'PO Deletions' },
  { key: 'standard_cost', label: 'Standard Cost' },
  { key: 'discontinue', label: 'Discontinue' },
  { key: 'vendor_deboarding', label: 'Vendor De-Boarding' },
  { key: 'receivable_plan', label: 'Inward Plan' },
];

export function ApprovalsClient({
  items,
  log,
  role,
  stats,
  context = {},
}: {
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
  role: SdRole;
  stats: { approved: number; edited: number; pct: number };
  /** Item 1: per-product inline approval context, keyed by product_code. */
  context?: Record<string, ApprovalContext>;
}) {
  const [filter, setFilter] = useState<'all' | 'mine'>('mine');
  const [typeFilter, setTypeFilter] = useState<ApprovalEntity | 'all'>('all');

  const mine = items.filter((item) => canApprove(role, item.status));
  const byLevel = filter === 'mine' ? mine : items;
  const shown =
    typeFilter === 'all' ? byLevel : byLevel.filter((item) => item.entityType === typeFilter);
  const shownLog =
    typeFilter === 'all' ? log : log.filter((row) => row.entity_type === typeFilter);

  // Buying-plan pivot: full scale (Total Qty/Value) + Woven-vs-Knitted split
  // across every plan in the queue, so the approver sees the shape before drilling.
  const pivotRows = items
    .filter((item) => item.entityType === 'buying_plan' && item.track !== 'material')
    .flatMap((item) =>
      (item.lines ?? []).map((l) => ({
        fabricType: l.fabricType ?? null,
        qty: l.qty ?? 0,
        value: l.value ?? 0,
        approved: l.lineStatus === 'approved',
      })),
    );

  return (
    <>
      {(typeFilter === 'all' || typeFilter === 'buying_plan') && (
        <PlanPivot rows={pivotRows} title="Buying plans awaiting approval — Woven vs Knitted" />
      )}

      <div className="metric-grid wf-metric-grid">
        <div className="metric-card tone-orange">
          <span className="metric-label">Awaiting my decision</span>
          <strong>{mine.length}</strong>
        </div>
        <div className="metric-card tone-purple">
          <span className="metric-label">In queue (all levels)</span>
          <strong>{items.length}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">My level</span>
          <strong>{ROLE_LABEL[role]}</strong>
        </div>
        <div className="metric-card tone-red">
          <span className="metric-label">Approvals that needed edits</span>
          <strong>{stats.pct}%</strong>
          <small>
            {stats.edited} of {stats.approved} approved
          </small>
        </div>
      </div>

      <div className="wf-toolbar">
        <div className="segment wf-segment">
          <button
            type="button"
            className={filter === 'mine' ? 'active' : ''}
            onClick={() => setFilter('mine')}
          >
            Awaiting me
          </button>
          <button
            type="button"
            className={filter === 'all' ? 'active' : ''}
            onClick={() => setFilter('all')}
          >
            Everything pending
          </button>
        </div>
        <div className="segment wf-segment">
          <button
            type="button"
            className={typeFilter === 'all' ? 'active' : ''}
            onClick={() => setTypeFilter('all')}
          >
            All types ({byLevel.length})
          </button>
          {TYPE_TABS.map((t) => {
            const count = byLevel.filter((item) => item.entityType === t.key).length;
            return (
              <button
                type="button"
                key={t.key}
                className={typeFilter === t.key ? 'active' : ''}
                onClick={() => setTypeFilter(t.key)}
              >
                {t.label} ({count})
              </button>
            );
          })}
        </div>
      </div>

      <div className="wf-queue">
        {shown.map((item) => (
          <article
            key={`${item.entityType}-${item.entityId}`}
            className={`wf-queue-card${
              item.entityType === 'buying_plan' || item.entityType === 'po_approval'
                ? ' wf-queue-card-wide'
                : ''
            }`}
          >
            <div className="wf-queue-head">
              <div>
                <h3>{item.label}</h3>
                <p className="wf-subtle">{item.sublabel}</p>
              </div>
              <StatusBadge status={item.status} />
            </div>
            <dl className="wf-queue-meta">
              <div>
                <dt>Submitted by</dt>
                <dd>{item.submittedBy ?? '—'}</dd>
              </div>
              <div>
                <dt>Submitted</dt>
                <dd>
                  {item.submittedAt
                    ? new Date(item.submittedAt).toLocaleDateString('en-IN')
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>Needs</dt>
                <dd>{ROLE_LABEL[item.requiredRole]}</dd>
              </div>
              {item.submitNote && (
                <div className="wf-queue-note">
                  <dt>Submitter remark</dt>
                  <dd>{item.submitNote}</dd>
                </div>
              )}
              {item.entityType === 'po_approval' && item.vendorCode && (
                <>
                  <div>
                    <dt>Vendor load (live)</dt>
                    <dd>
                      {item.vendorInProcessQty == null
                        ? 'No open POs'
                        : `${item.vendorInProcessQty.toLocaleString('en-IN')} pcs in process`}
                    </dd>
                  </div>
                  <div>
                    <dt>PO capacity ({item.vendorLeadDays ?? '—'}-day lead)</dt>
                    <dd>
                      {item.vendorPoCapacity ? (
                        <>
                          <strong>{item.vendorPoCapacity.toLocaleString('en-IN')} pcs</strong>
                          {item.vendorCapacityUtil != null ? ` · ${item.vendorCapacityUtil}% used` : ''}
                          <small className="wf-subtle wf-block">
                            {item.vendorCapacityPerMonth?.toLocaleString('en-IN') ?? '—'} pcs/mo
                            {item.vendorCapacityUpdatedAt
                              ? ` · sheet ${new Date(item.vendorCapacityUpdatedAt).toLocaleDateString('en-IN')}`
                              : ''}
                          </small>
                        </>
                      ) : (
                        'Not entered on Vendor Capacity'
                      )}
                    </dd>
                  </div>
                </>
              )}
            </dl>
            {item.entityType === 'po_approval' && item.poDetail && (
              <PoApprovalDetail item={item} />
            )}
            {item.entityType === 'buying_plan' &&
              canApprove(role, item.status) &&
              !!item.lines?.length && <BuyingPlanApprovalLines item={item} context={context} />}
            <div className="wf-queue-foot">
              {item.entityType === 'standard_cost' ? (
                // Cost is negotiated on its own screen — accept / reject / set
                // target / sign off all live there. Link out rather than duplicate.
                <Link href={item.href} className="wf-btn wf-btn-primary">
                  Review on Standard Cost →
                </Link>
              ) : (
                <>
                  <Link href={item.href} className="wf-btn wf-btn-ghost">
                    Open record
                  </Link>
                  {/* Buying plans are actioned entirely inside BuyingPlanApprovalLines
                      (Approve/Rework scoped to the ticked rows). The whole-record
                      LineRework modal + ApprovalBar are only for the other types, so a
                      buying-plan approver can't accidentally act on all lines at once. */}
                  {item.entityType !== 'buying_plan' &&
                    canApprove(role, item.status) &&
                    !!item.lines?.length && (
                      <LineRework
                        entityType={item.entityType}
                        entityId={item.entityId}
                        entityLabel={item.label}
                        lines={item.lines}
                        onDone={(result) => {
                          if (result.ok) reloadWithToast(result.message ?? 'Saved.');
                        }}
                      />
                    )}
                  {item.entityType !== 'buying_plan' && canApprove(role, item.status) && (
                    <ApprovalBar
                      entityType={item.entityType}
                      entityId={item.entityId}
                      entityLabel={item.label}
                      onDone={(result) => {
                        if (result.ok) reloadWithToast(result.message ?? 'Saved.');
                      }}
                    />
                  )}
                </>
              )}
            </div>
          </article>
        ))}
        {!shown.length && (
          <div className="empty-state">
            <ShieldCheck size={28} />
            <p>
              {typeFilter === 'all'
                ? 'Nothing waiting on you.'
                : `No ${TYPE_TABS.find((t) => t.key === typeFilter)?.label.toLowerCase() ?? 'items'} pending.`}
            </p>
          </div>
        )}
      </div>

      <div className="wf-history-block">
        <h3 className="wf-card-title">Approval history</h3>
        <FilterTable
          rows={shownLog}
          columns={LOG_COLS}
          rowKey={(r) => String(r.id)}
          defaultSource="supabase"
          unit="decisions"
          searchPlaceholder="Record, actor, notes…"
          emptyText={typeFilter === 'all' ? 'No decisions recorded yet.' : 'No recent decisions of this type.'}
          download={{ filename: 'approval-history' }}
        />
      </div>
    </>
  );
}

/**
 * Per-line multi-select approval for a Buying Plan. The approver ticks the lines
 * they're happy with (individually or select-all) and approves them in one action;
 * the header only flips to Approved once every non-zero line is approved. Lines
 * that need re-evaluation go back via the separate LineRework modal.
 */
function BuyingPlanApprovalLines({
  item,
  context = {},
}: {
  item: ApprovalQueueItem;
  context?: Record<string, ApprovalContext>;
}) {
  const lines = item.lines ?? [];
  // Item 1's inline context only applies to FG products (garment stock/DOQ).
  const showContext = item.track !== 'material';
  const pendingLines = lines.filter((l) => l.lineStatus !== 'approved');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<null | 'rework'>(null);
  const [remark, setRemark] = useState('');
  const [isBusy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allChecked = pendingLines.length > 0 && pendingLines.every((l) => selected.has(l.id));
  // Only pending lines can be acted on — an already-approved row's checkbox is
  // never rendered, but guard anyway so a stale id can't slip into an action.
  const actionable = [...selected].filter((id) => pendingLines.some((l) => l.id === id));

  // §7 pivoted summary: Woven/Knitted × (Qty, Value) × (Pending, Approved) — the
  // at-a-glance total the approver sees before working individual lines.
  const pivot = (() => {
    const m = new Map<string, { pendQty: number; pendVal: number; apprQty: number; apprVal: number }>();
    for (const l of lines) {
      const fab = l.fabricType || 'Unspecified';
      const cur = m.get(fab) ?? { pendQty: 0, pendVal: 0, apprQty: 0, apprVal: 0 };
      if (l.lineStatus === 'approved') {
        cur.apprQty += l.qty ?? 0;
        cur.apprVal += l.value ?? 0;
      } else {
        cur.pendQty += l.qty ?? 0;
        cur.pendVal += l.value ?? 0;
      }
      m.set(fab, cur);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();

  function toggle(id: string) {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allChecked ? new Set() : new Set(pendingLines.map((l) => l.id)));
  }

  function approve() {
    if (!actionable.length) return;
    setError(null);
    const payload = new FormData();
    payload.set('plan_id', item.entityId);
    payload.set('line_ids', JSON.stringify(actionable));
    start(async () => {
      const result = await approveBuyingPlanLines(payload);
      if (result.ok) reloadWithToast(result.message ?? 'Saved.');
      else setError(toastError(result.error));
    });
  }

  function rework() {
    if (!actionable.length) return;
    if (!remark.trim()) {
      setError('Add a remark so the submitter knows what to change.');
      return;
    }
    setError(null);
    // The same remark is recorded against each checked line sent back.
    const decisions = actionable.map((lineId) => ({ lineId, note: remark.trim() }));
    const payload = new FormData();
    payload.set('entity_type', item.entityType);
    payload.set('entity_id', item.entityId);
    payload.set('entity_label', item.label);
    payload.set('line_decisions', JSON.stringify(decisions));
    start(async () => {
      const result = await reworkLines(payload);
      if (result.ok) reloadWithToast(result.message ?? 'Saved.');
      else setError(toastError(result.error));
    });
  }

  return (
    <div className="wf-line-approve">
      {pivot.length > 0 && (
        <div className="table-scroll wf-pivot-wrap">
          <table className="wide-table wf-pivot-table">
            <thead>
              <tr>
                <th rowSpan={2}>{item.track === 'material' ? 'Type' : 'Fabric'}</th>
                <th className="num" colSpan={2}>Pending <HeaderInfo label="Pending" /></th>
                <th className="num" colSpan={2}>Approved <HeaderInfo label="Approved" /></th>
              </tr>
              <tr>
                <th className="num">Qty <HeaderInfo label="Qty" /></th>
                <th className="num">Value <HeaderInfo label="Value" /></th>
                <th className="num">Qty <HeaderInfo label="Qty" /></th>
                <th className="num">Value <HeaderInfo label="Value" /></th>
              </tr>
            </thead>
            <tbody>
              {pivot.map(([fab, v]) => (
                <tr key={fab}>
                  <td className="strong">{fab}</td>
                  <td className="num">{fmt.format(v.pendQty)}</td>
                  <td className="num">{money.format(v.pendVal)}</td>
                  <td className="num">{fmt.format(v.apprQty)}</td>
                  <td className="num">{money.format(v.apprVal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-scroll">
        <table className="wide-table wf-line-table">
          <thead>
            <tr>
              <th className="wf-line-check">
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  disabled={!pendingLines.length}
                  aria-label="Select all pending lines"
                />
              </th>
              <th>{item.track === 'material' ? 'Material' : 'Product'}</th>
              <th className="num">Qty <HeaderInfo label="Qty" /></th>
              <th className="num">Value <HeaderInfo label="Value" /></th>
              <th>{item.track === 'material' ? 'Type' : 'Fabric'}</th>
              <th>State <HeaderInfo label="State" /></th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const approved = l.lineStatus === 'approved';
              const ctx = showContext ? context[productCodeFromLineLabel(l.label)] : undefined;
              return (
                <Fragment key={l.id}>
                  <tr className={approved ? 'wf-line-approved' : ''}>
                    <td className="wf-line-check">
                      {!approved && (
                        <input
                          type="checkbox"
                          checked={selected.has(l.id)}
                          onChange={() => toggle(l.id)}
                          aria-label={`Select ${l.label}`}
                        />
                      )}
                    </td>
                    <td className="mono">{l.label}</td>
                    <td className="num">{fmt.format(l.qty ?? 0)}</td>
                    <td className="num">{money.format(l.value ?? 0)}</td>
                    <td>{l.fabricType || '—'}</td>
                    <td>
                      {approved ? (
                        <span className="wf-tag-approved">approved</span>
                      ) : (
                        <span className="wf-subtle">pending</span>
                      )}
                    </td>
                  </tr>
                  {showContext && !approved && (
                    <tr className="wf-line-context-row">
                      <td />
                      <td colSpan={5}>
                        <ApprovalContextPanel ctx={ctx} pendingQty={l.qty} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="wf-line-error">{error}</p>}

      {/* Rework remark appears inline, at the point of action — required, and it
          applies to exactly the checked rows (never the whole plan). */}
      {mode === 'rework' && (
        <div className="wf-line-rework-inline">
          <label className="wf-subtle" htmlFor={`rework-${item.entityId}`}>
            Remark for the {actionable.length} checked line(s) — sent to the submitter
          </label>
          <textarea
            id={`rework-${item.entityId}`}
            className="wf-textarea"
            rows={2}
            placeholder="What needs to change on these lines?"
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            autoFocus
          />
          <div className="wf-line-rework-actions">
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={rework}
              disabled={isBusy || !actionable.length}
            >
              <RotateCcw size={14} /> {isBusy ? 'Working…' : `Send ${actionable.length} line(s) for rework`}
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              onClick={() => { setMode(null); setRemark(''); setError(null); }}
              disabled={isBusy}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="wf-line-approve-foot">
        <span className="wf-subtle">
          {pendingLines.length} line(s) pending · {lines.length - pendingLines.length} approved
          {actionable.length > 0 && (
            <> · <strong>{actionable.length} checked</strong> — actions apply to these only</>
          )}
        </span>
        {mode !== 'rework' && (
          <div className="wf-line-action-btns">
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              onClick={() => { setMode('rework'); setError(null); }}
              disabled={isBusy || !actionable.length}
            >
              <RotateCcw size={14} /> Rework selected ({actionable.length})
            </button>
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={approve}
              disabled={isBusy || !actionable.length}
            >
              <CheckCheck size={14} /> {isBusy ? 'Approving…' : `Approve selected (${actionable.length})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const fmtNum = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('en-IN');
const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('en-IN') : '—';

/**
 * The inline "4 things Mahesh verifies" panel on a PO approval card — expands
 * the one-line entry into tabs (Inventory / Standard Cost / TNA / Vendor) so the
 * whole review happens without leaving the queue.
 */
/** A small verdict chip: green when the check passes, red when it is worth a look. */
function Verdict({ ok, text }: { ok: boolean | null; text: string }) {
  return <span className={`wf-verdict ${ok == null ? 'is-none' : ok ? 'is-ok' : 'is-flag'}`}>{text}</span>;
}

/**
 * The four things an approver verifies on a PO — Stock, Cost, TNA, Vendor — as four panels
 * that are always visible, each with the headline figure first, a verdict, and the numbers
 * behind it. Nothing hides behind a button: the card is the review.
 */
function PoApprovalDetail({ item }: { item: ApprovalQueueItem }) {
  const d = item.poDetail!;
  const std = d.stdCost;
  const stdForType = std
    ? d.poType === 'job_work'
      ? std.job
      : d.poType === 'efob'
        ? std.efob
        : std.fob
    : null;
  const variance = d.writtenRate != null && stdForType != null ? d.writtenRate - stdForType : null;
  const cmDelta = d.poCm != null && d.stdCm != null ? d.poCm - d.stdCm : null;
  const fabricDelta =
    d.poFinishedFabric != null && d.stdFinishedFabric != null ? d.poFinishedFabric - d.stdFinishedFabric : null;
  const inproc = item.vendorInProcessQty ?? null;
  const cap = item.vendorPoCapacity ?? null;
  const headroom = cap != null && inproc != null ? cap - inproc : null;
  const util = item.vendorCapacityUtil ?? null;
  const utilWithPo = cap && cap > 0 && inproc != null ? Math.round(((inproc + d.poQty) / cap) * 1000) / 10 : null;
  const days = d.inventory?.daysOfStock ?? null;
  const typeLabel = d.poType === 'job_work' ? 'Job Work' : d.poType === 'efob' ? 'E-FOB' : d.poType ? 'FOB' : '—';

  return (
    <div className="wf-verify-grid">
      {/* ---- Stock */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Stock <InfoDot text={"WHAT: does this product need the pieces on this PO.\n\nHOW: from the nightly inventory snapshot: stock on hand, pieces already on order, and the 45-day daily demand. Days of stock = stock ÷ daily demand.\n\nUSE: plenty of days of stock and plenty on order → ask why the PO is needed now."} />
          </h4>
          {d.inventory ? (
            <Verdict ok={days == null ? null : days < 45} text={days == null ? 'no demand' : days < 45 ? `${days} days of stock` : `${days} days of stock`} />
          ) : (
            <Verdict ok={null} text="no snapshot" />
          )}
        </div>
        {d.inventory ? (
          <dl>
            <div><dt>In stock</dt><dd>{fmtNum(d.inventory.currentStock)} pcs</dd></div>
            <div><dt>Already on order</dt><dd>{fmtNum(d.inventory.inProgress)} pcs</dd></div>
            <div><dt>Sells a day</dt><dd>{d.inventory.doq45}</dd></div>
            <div><dt>This PO adds</dt><dd>{fmtNum(d.poQty)} pcs</dd></div>
          </dl>
        ) : (
          <p className="wf-subtle">No inventory snapshot for {d.productCode ?? 'this product'}.</p>
        )}
      </section>

      {/* ---- Cost */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Cost <InfoDot text={"WHAT: is the rate on this PO above the approved Standard Cost.\n\nHOW: written rate − standard for this PO type. CM (cut-make) is shown against standard CM because that is what the vendor controls; grey and finished fabric are commodity and move with the market — informational.\n\nUSE: above standard needs a reason (the submitter's remark is at the top of the card); the Standard Cost link opens the negotiation record."} />
          </h4>
          <Verdict
            ok={variance == null ? null : variance <= 0.005}
            text={variance == null ? 'no standard' : variance > 0.005 ? `₹${fmtNum(variance)} above standard` : 'at or below standard'}
          />
        </div>
        <dl>
          <div><dt>Rate on PO</dt><dd><strong>₹{fmtNum(d.writtenRate)}</strong></dd></div>
          <div><dt>Standard ({typeLabel})</dt><dd>{stdForType != null ? `₹${fmtNum(stdForType)}` : 'not approved'}</dd></div>
          <div>
            <dt>CM vs standard</dt>
            <dd className={cmDelta != null && cmDelta > 0 ? 'wf-error-text' : undefined}>
              ₹{fmtNum(d.poCm)} vs {d.stdCm != null ? `₹${fmtNum(d.stdCm)}` : '—'}
              {cmDelta != null && cmDelta > 0 ? ` (+${fmtNum(cmDelta)})` : ''}
            </dd>
          </div>
          <div>
            <dt>Fabric vs std <small>commodity</small></dt>
            <dd className="wf-subtle">
              ₹{fmtNum(d.poFinishedFabric)} vs {d.stdFinishedFabric != null ? `₹${fmtNum(d.stdFinishedFabric)}` : '—'}
              {fabricDelta != null && fabricDelta !== 0 ? ` (${fabricDelta > 0 ? '+' : ''}${fmtNum(fabricDelta)})` : ''}
            </dd>
          </div>
        </dl>
        {d.productCode && (
          <Link className="wf-verify-link" href={`/standard-cost/${encodeURIComponent(d.productCode)}`}>
            Open Standard Cost →
          </Link>
        )}
      </section>

      {/* ---- TNA */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            TNA <InfoDot text={"WHAT: the production timeline the PO commits to.\n\nHOW: the critical-path dates as entered — PP sample, GPT, cutting, inline QC, first delivery, closing — and the days from submission to first delivery. 'Confirmed' means an approver has locked the dates; cost cannot be approved before that.\n\nUSE: compare the requested days with what this vendor actually takes (Vendor Performance → OTIF scorecard)."} />
          </h4>
          <Verdict ok={d.tna.tnaConfirmed} text={d.tna.tnaConfirmed ? 'dates confirmed' : 'dates not confirmed'} />
        </div>
        <dl>
          <div><dt>Days to delivery</dt><dd><strong>{d.tna.requestedTotalDays ?? '—'}</strong></dd></div>
          <div><dt>First delivery</dt><dd>{fmtDate(d.tna.firstDelivery)}</dd></div>
          <div><dt>PP sample · GPT</dt><dd>{fmtDate(d.tna.ppSampleDue)} · {fmtDate(d.tna.gptDue)}</dd></div>
          <div><dt>Cutting · Inline QC</dt><dd>{fmtDate(d.tna.cuttingStart)} · {fmtDate(d.tna.inlineQcDue)}</dd></div>
          <div><dt>PO closing</dt><dd>{fmtDate(d.tna.poClosingDate)}</dd></div>
        </dl>
      </section>

      {/* ---- Vendor */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Vendor <InfoDot text={"WHAT: can the vendor take this PO on top of what they already have.\n\nHOW: PO capacity = what the vendor can make inside this PO type's lead time (the one capacity model, from the Vendor Capacity sheet and Rules Master). Headroom = PO capacity − pieces already in process. 'With this PO' = (in process + this PO) ÷ PO capacity.\n\nUSE: past 100% with this PO, something will be late — decide which."} />
          </h4>
          {cap == null ? (
            <Verdict ok={null} text="capacity not entered" />
          ) : (
            <Verdict ok={utilWithPo != null && utilWithPo <= 100} text={utilWithPo != null ? `${utilWithPo}% with this PO` : '—'} />
          )}
        </div>
        <dl>
          <div><dt>In process</dt><dd>{inproc == null ? 'no open POs' : `${fmtNum(inproc)} pcs`}{util != null ? <small className="wf-subtle"> · {util}% of PO capacity</small> : null}</dd></div>
          <div><dt>PO capacity ({item.vendorLeadDays ?? '—'}-day lead)</dt><dd>{cap == null ? 'not entered' : `${fmtNum(cap)} pcs`}</dd></div>
          <div><dt>Headroom</dt><dd className={headroom != null && headroom < d.poQty ? 'wf-error-text' : undefined}>{headroom != null ? `${fmtNum(headroom)} pcs` : '—'}{headroom != null && headroom < d.poQty ? ' — less than this PO' : ''}</dd></div>
          <div><dt>Capacity / month</dt><dd>{item.vendorCapacityPerMonth != null ? `${fmtNum(item.vendorCapacityPerMonth)} pcs` : '—'}{item.vendorCapacityUpdatedAt ? ` · ${fmtDate(item.vendorCapacityUpdatedAt)}` : ''}</dd></div>
        </dl>
      </section>
    </div>
  );
}
