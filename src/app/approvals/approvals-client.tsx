'use client';

import { Fragment, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { reloadWithToast, toastError } from '@/lib/toast';
import Link from 'next/link';
import { CheckCheck, RotateCcw, ShieldCheck } from 'lucide-react';
import { canApprove, LEVEL_LABEL, ROLE_LABEL, STATUS_LABEL, statusText } from '@/lib/forms/approval';
import { approveBuyingPlanLines, reworkLines } from '@/lib/forms/actions';
import { StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { PoReviewPanels } from '@/components/forms/po-review-panels';
import { CostDecisionBar } from '@/components/forms/cost-decision-bar';
import { decideCostsBulk } from '@/lib/forms/actions';
import { LineRework } from '@/components/forms/line-rework';
import { PlanPivot } from '@/components/forms/plan-pivot';
import { ApprovalContextPanel } from '@/components/forms/approval-context-panel';
import { productCodeFromLineLabel, type ApprovalContext } from '@/lib/approval-context';
import { FilterTable, type Column } from '@/components/filter-table';
import type { ApprovalEntity, ApprovalLogRow, ApprovalQueueItem, SdRole } from '@/lib/forms/types';
import { utilisationLabel } from '@/lib/utilisation';

// An approval made through Edit & approve records its changes in the notes; say so in the log.
const logTo = (r: ApprovalLogRow) =>
  statusText(r.to_status, { approverEdited: r.to_status === 'approved' && (r.notes ?? '').startsWith('Edited by the approver') });

// Columns for the approval-history log (read-only decision list) → shared FilterTable.
const LOG_COLS: Column<ApprovalLogRow>[] = [
  { key: 'created_at', label: 'When', accessor: (r) => r.created_at, render: (r) => <span className="wf-subtle">{new Date(r.created_at).toLocaleString('en-IN')}</span> },
  { key: 'record', label: 'Record', accessor: (r) => r.entity_label ?? `${r.entity_type} #${r.entity_id}`, render: (r) => r.entity_label ?? `${r.entity_type} #${r.entity_id}` },
  { key: 'change', label: 'Change', accessor: (r) => logTo(r), render: (r) => (<>{r.from_status ? STATUS_LABEL[r.from_status] : '—'} → <strong>{logTo(r)}</strong></>) },
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
  { key: 'po_amendment', label: 'PO Amendments' },
  { key: 'standard_cost', label: 'Standard Cost' },
  { key: 'discontinue', label: 'Discontinue' },
  { key: 'vendor_deboarding', label: 'Vendor De-Boarding' },
  { key: 'inward_plan', label: 'Inward Plan (month)' },
  { key: 'receivable_plan', label: 'Inward Plan (weekly)' },
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
  // Cost proposals ticked for a bulk accept / reject (queue entity ids: f<id> / m<id>).
  const [pickedCosts, setPickedCosts] = useState<Set<string>>(new Set());
  const toggleCost = (id: string) =>
    setPickedCosts((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

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

      {role === 'admin' && shown.filter((i) => i.entityType === 'standard_cost' && i.costRecord?.neg_stage === 'proposed').length > 1 && (
        <CostBulkBar
          items={shown.filter((i) => i.entityType === 'standard_cost' && i.costRecord?.neg_stage === 'proposed')}
          picked={pickedCosts}
          setPicked={setPickedCosts}
        />
      )}

      <div className="wf-queue">
        {shown.map((item) => (
          <article
            key={`${item.entityType}-${item.entityId}`}
            className={`wf-queue-card${
              item.entityType === 'buying_plan' || item.entityType === 'po_approval' || item.entityType === 'inward_plan'
                ? ' wf-queue-card-wide'
                : ''
            }`}
          >
            <div className="wf-queue-head">
              <div>
                <h3>{item.label}</h3>
                <p className="wf-subtle">{item.sublabel}</p>
              </div>
              <span className="wf-inline-actions">
                {item.entityType === 'standard_cost' && item.costRecord?.neg_stage === 'proposed' && role === 'admin' && (
                  <label className="wf-subtle" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <input type="checkbox" checked={pickedCosts.has(item.entityId)} onChange={() => toggleCost(item.entityId)} aria-label={`Select ${item.label} for bulk decision`} />
                    select
                  </label>
                )}
                <StatusBadge status={item.status} />
              </span>
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
              {/* Spec 7.5 — whose turn it is by name, and whether they have sat on it. */}
              {item.level && (
                <div>
                  <dt>Waiting on</dt>
                  <dd>
                    {item.approvers?.length
                      ? `${LEVEL_LABEL[item.level]} — ${item.approvers.join(', ')}`
                      : `${LEVEL_LABEL[item.level]} — nobody named yet`}
                    {item.daysWaiting != null && (
                      <span className={item.escalated ? 'wf-over-tag' : 'wf-subtle'} style={{ marginLeft: 6 }}>
                        {item.escalated
                          ? `escalated · ${item.daysWaiting}d waiting`
                          : `${item.daysWaiting}d waiting`}
                      </span>
                    )}
                  </dd>
                </div>
              )}
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
                          {item.vendorCapacityUtil != null ? ` · ${utilisationLabel(item.vendorCapacityUtil)} used` : ''}
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
              <PoReviewPanels item={item} role={role} />
            )}
            {item.entityType === 'buying_plan' &&
              canApprove(role, item.status) &&
              !!item.lines?.length && <BuyingPlanApprovalLines item={item} context={context} />}
            {item.entityType === 'inward_plan' && !!item.lines?.length && <InwardPlanLines item={item} />}
            {item.entityType === 'standard_cost' && item.costRecord && item.costTrack && (
              // The same decision bar as the product page — decide here, open the
              // product only when the cost sheet itself needs a look.
              <CostDecisionBar cost={item.costRecord} role={role} track={item.costTrack} compact />
            )}
            <div className="wf-queue-foot">
              {item.entityType === 'standard_cost' ? (
                <Link href={item.href} className="wf-btn wf-btn-ghost">
                  Open the cost sheet →
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
                    item.entityType !== 'inward_plan' &&
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

      <div className="wf-line-approve-foot">
        <span className="wf-subtle">
          {pendingLines.length} line(s) pending · {lines.length - pendingLines.length} approved
          {actionable.length > 0 && <> · <strong>{actionable.length} ticked</strong> — decide them from the bar below</>}
        </span>
      </div>

      {/* Ticked lines are decided from the same floating bar as the Buying Plan and Standard
          Cost. The rework remark applies to exactly the ticked lines (never the whole plan). */}
      {actionable.length > 0 && (
        <div className="bp-bulk-bar" role="region" aria-label={`Decide the ticked lines of ${item.label}`}>
          <span className="bp-bulk-count">
            {item.label} · <b>{actionable.length}</b> line{actionable.length === 1 ? '' : 's'} ticked
          </span>
          {mode === 'rework' ? (
            <>
              <input
                autoFocus
                value={remark}
                onChange={(e) => setRemark(e.target.value)}
                placeholder="What needs to change on these lines? (sent to the submitter)"
                aria-label="Rework remark for the ticked lines"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && remark.trim()) rework();
                  if (e.key === 'Escape') setMode(null);
                }}
              />
              <button type="button" className="bp-bulk-btn strong" onClick={rework} disabled={isBusy || !remark.trim()}>
                <RotateCcw size={13} /> {isBusy ? 'Working…' : `Send ${actionable.length} back`}
              </button>
              <button type="button" className="bp-bulk-btn" onClick={() => { setMode(null); setRemark(''); setError(null); }} disabled={isBusy}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bp-bulk-btn strong" onClick={approve} disabled={isBusy}>
                <CheckCheck size={13} /> {isBusy ? 'Approving…' : `Approve ${actionable.length}`}
              </button>
              <button type="button" className="bp-bulk-btn" onClick={() => { setMode('rework'); setError(null); }} disabled={isBusy}>
                <RotateCcw size={13} /> Rework
              </button>
              <button type="button" className="bp-bulk-btn" onClick={() => setSelected(new Set())} disabled={isBusy}>
                Clear
              </button>
            </>
          )}
          {error && <span className="bp-bulk-error">{error}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Read-only sheet behind a monthly inward-plan card: one row per PO line the team
 * intends to inward that month. The whole month is approved / reworked / rejected
 * from the ApprovalBar below it; the note travels to every row as the management comment.
 */
function InwardPlanLines({ item }: { item: ApprovalQueueItem }) {
  const lines = item.lines ?? [];
  const qty = lines.reduce((s, l) => s + (l.qty ?? 0), 0);
  const value = lines.reduce((s, l) => s + (l.value ?? 0), 0);
  return (
    <div className="table-scroll">
      <table className="wide-table wf-line-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>PO</th>
            <th>Vendor</th>
            <th className="num">Inward qty</th>
            <th className="num">Value at cost</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const [product, po, vendor] = l.label.split(' · ');
            return (
              <tr key={l.id}>
                <td className="mono">{product}</td>
                <td className="mono">{po}</td>
                <td>{vendor}</td>
                <td className="num">{(l.qty ?? 0).toLocaleString('en-IN')}</td>
                <td className="num">₹{Math.round(l.value ?? 0).toLocaleString('en-IN')}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>
              <strong>{lines.length} line(s)</strong>
            </td>
            <td className="num">
              <strong>{qty.toLocaleString('en-IN')}</strong>
            </td>
            <td className="num">
              <strong>₹{Math.round(value).toLocaleString('en-IN')}</strong>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * Bulk accept / reject for cost proposals: tick the cards (or select all in view) and
 * decide them together. Each one still goes through the single-row action, so a row
 * that cannot be accepted is reported by product code rather than skipped.
 */
function CostBulkBar({
  items,
  picked,
  setPicked,
}: {
  items: ApprovalQueueItem[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
}) {
  const [mode, setMode] = useState<'' | 'reject'>('');
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  const ids = items.map((i) => i.entityId);
  const chosen = ids.filter((id) => picked.has(id));
  const allPicked = chosen.length === ids.length;

  function decide(decision: 'accept' | 'reject') {
    const fd = new FormData();
    fd.set('decision', decision);
    fd.set('ids', chosen.join(','));
    fd.set('note', note);
    start(async () => {
      const res = await decideCostsBulk(fd);
      if (!res.ok) toastError(res.error);
      else reloadWithToast(res.message ?? 'Done.');
    });
  }

  return (
    <div className="wf-queue-card wf-queue-card-wide sc-decision" style={{ marginBottom: 16 }}>
      <div className="wf-queue-head">
        <div>
          <h3>{items.length} cost proposals waiting — decide them together</h3>
          <p className="wf-subtle">
            Tick the ones to accept as-is (the proposed rate becomes the standard cost) or reject with one reason.
            Proposals that need a target, or name no rate, are best decided on their own card.
          </p>
        </div>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setPicked(allPicked ? new Set() : new Set(ids))}>
          {allPicked ? 'Untick all' : `Tick all to decide (${ids.length})`}
        </button>
      </div>
      {chosen.length > 0 && (
        <div className="bp-bulk-bar" role="region" aria-label="Decide the ticked cost proposals">
          <span className="bp-bulk-count">
            <b>{chosen.length}</b> proposal{chosen.length === 1 ? '' : 's'} ticked
          </span>
          {mode === 'reject' ? (
            <>
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Reason for rejection — recorded on every ticked proposal"
                aria-label="Reason to reject the ticked proposals"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && note.trim()) decide('reject');
                  if (e.key === 'Escape') setMode('');
                }}
              />
              <button type="button" className="bp-bulk-btn strong" disabled={pending || !note.trim()} onClick={() => decide('reject')}>
                {pending ? 'Working…' : `Reject ${chosen.length}`}
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => { setMode(''); setNote(''); }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => decide('accept')}>
                <CheckCheck size={13} /> {pending ? 'Working…' : `Accept ${chosen.length}`}
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setMode('reject')}>
                Reject
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
