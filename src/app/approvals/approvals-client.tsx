'use client';

import { useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import Link from 'next/link';
import { CheckCheck, ShieldCheck } from 'lucide-react';
import { canApprove, ROLE_LABEL, STATUS_LABEL } from '@/lib/forms/approval';
import { approveBuyingPlanLines } from '@/lib/forms/actions';
import { StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { LineRework } from '@/components/forms/line-rework';
import { PlanPivot } from '@/components/forms/plan-pivot';
import type { ApprovalEntity, ApprovalLogRow, ApprovalQueueItem, SdRole } from '@/lib/forms/types';

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
  { key: 'standard_cost', label: 'Standard Cost' },
  { key: 'discontinue', label: 'Discontinue' },
  { key: 'receivable_plan', label: 'Receivable Plan' },
];

export function ApprovalsClient({
  items,
  log,
  role,
  stats,
}: {
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
  role: SdRole;
  stats: { approved: number; edited: number; pct: number };
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
          <article key={`${item.entityType}-${item.entityId}`} className="wf-queue-card">
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
                    <dt>Capacity (last updated)</dt>
                    <dd>
                      {item.vendorCapacityPerMonth
                        ? `${item.vendorCapacityPerMonth.toLocaleString('en-IN')} pcs/mo${
                            item.vendorCapacityUpdatedAt
                              ? ` · ${new Date(item.vendorCapacityUpdatedAt).toLocaleDateString('en-IN')}`
                              : ''
                          }`
                        : 'Not logged yet'}
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
              !!item.lines?.length && <BuyingPlanApprovalLines item={item} />}
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
                  {canApprove(role, item.status) && !!item.lines?.length && (
                    <LineRework
                      entityType={item.entityType}
                      entityId={item.entityId}
                      entityLabel={item.label}
                      lines={item.lines}
                      onDone={(result) => {
                        if (result.ok) reloadWithToast();
                      }}
                    />
                  )}
                  {canApprove(role, item.status) && (
                    <ApprovalBar
                      entityType={item.entityType}
                      entityId={item.entityId}
                      entityLabel={item.label}
                      onDone={(result) => {
                        if (result.ok) reloadWithToast();
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

      <div className="table-panel">
        <div className="table-meta">
          <h3>Approval history</h3>
          <span>
            {typeFilter === 'all'
              ? `Last ${shownLog.length} decisions`
              : `${shownLog.length} of the last ${log.length} decisions`}
          </span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Record</th>
                <th>Change</th>
                <th>Actor</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {shownLog.map((row) => (
                <tr key={row.id}>
                  <td className="wf-subtle">
                    {new Date(row.created_at).toLocaleString('en-IN')}
                  </td>
                  <td>{row.entity_label ?? `${row.entity_type} #${row.entity_id}`}</td>
                  <td>
                    {row.from_status ? STATUS_LABEL[row.from_status] : '—'} →{' '}
                    <strong>{STATUS_LABEL[row.to_status]}</strong>
                  </td>
                  <td className="wf-subtle">{row.actor_email}</td>
                  <td>{row.notes ?? '—'}</td>
                </tr>
              ))}
              {!shownLog.length && (
                <tr>
                  <td colSpan={5} className="wf-empty-cell">
                    {typeFilter === 'all'
                      ? 'No decisions recorded yet.'
                      : 'No recent decisions of this type.'}
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

/**
 * Per-line multi-select approval for a Buying Plan. The approver ticks the lines
 * they're happy with (individually or select-all) and approves them in one action;
 * the header only flips to Approved once every non-zero line is approved. Lines
 * that need re-evaluation go back via the separate LineRework modal.
 */
function BuyingPlanApprovalLines({ item }: { item: ApprovalQueueItem }) {
  const lines = item.lines ?? [];
  const pendingLines = lines.filter((l) => l.lineStatus !== 'approved');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isBusy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const allChecked = pendingLines.length > 0 && pendingLines.every((l) => selected.has(l.id));

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
    if (!selected.size) return;
    setError(null);
    const payload = new FormData();
    payload.set('plan_id', item.entityId);
    payload.set('line_ids', JSON.stringify([...selected]));
    start(async () => {
      const result = await approveBuyingPlanLines(payload);
      if (result.ok) reloadWithToast();
      else setError(result.error);
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
                <th className="num" colSpan={2}>Pending</th>
                <th className="num" colSpan={2}>Approved</th>
              </tr>
              <tr>
                <th className="num">Qty</th>
                <th className="num">Value</th>
                <th className="num">Qty</th>
                <th className="num">Value</th>
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
              <th className="num">Qty</th>
              <th className="num">Value</th>
              <th>{item.track === 'material' ? 'Type' : 'Fabric'}</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const approved = l.lineStatus === 'approved';
              return (
                <tr key={l.id} className={approved ? 'wf-line-approved' : ''}>
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
              );
            })}
          </tbody>
        </table>
      </div>
      {error && <p className="wf-line-error">{error}</p>}
      <div className="wf-line-approve-foot">
        <span className="wf-subtle">
          {pendingLines.length} line(s) pending · {lines.length - pendingLines.length} approved
        </span>
        <button
          type="button"
          className="wf-btn wf-btn-primary wf-btn-sm"
          onClick={approve}
          disabled={isBusy || !selected.size}
        >
          <CheckCheck size={14} /> {isBusy ? 'Approving…' : `Approve selected (${selected.size})`}
        </button>
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
function PoApprovalDetail({ item }: { item: ApprovalQueueItem }) {
  const d = item.poDetail!;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'inv' | 'cost' | 'tna' | 'vendor'>('inv');

  const std = d.stdCost;
  const stdForType = std
    ? d.poType === 'job_work'
      ? std.job
      : d.poType === 'efob'
        ? std.efob
        : std.fob
    : null;
  const variance =
    d.writtenRate != null && stdForType != null ? d.writtenRate - stdForType : null;
  const cmDelta = d.poCm != null && d.stdCm != null ? d.poCm - d.stdCm : null;
  const fabricDelta =
    d.poFinishedFabric != null && d.stdFinishedFabric != null
      ? d.poFinishedFabric - d.stdFinishedFabric
      : null;
  const inproc = item.vendorInProcessQty ?? null;
  const cap = item.vendorCapacityPerMonth ?? null;
  const headroom = cap != null && inproc != null ? cap - inproc : null;

  return (
    <div className="wf-po-detail">
      <button
        type="button"
        className="wf-btn wf-btn-ghost wf-btn-sm"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Hide detail' : 'Verify'} — DOQ · Cost · TNA · Vendor
      </button>
      {open && (
        <div className="wf-po-detail-body">
          <div className="segment wf-segment wf-po-tabs">
            <button type="button" className={tab === 'inv' ? 'active' : ''} onClick={() => setTab('inv')}>
              Inventory
            </button>
            <button type="button" className={tab === 'cost' ? 'active' : ''} onClick={() => setTab('cost')}>
              Standard Cost
            </button>
            <button type="button" className={tab === 'tna' ? 'active' : ''} onClick={() => setTab('tna')}>
              TNA
            </button>
            <button type="button" className={tab === 'vendor' ? 'active' : ''} onClick={() => setTab('vendor')}>
              Vendor
            </button>
          </div>

          {tab === 'inv' && (
            d.inventory ? (
              <dl className="wf-doc-meta">
                <div><dt>DOQ (45d)</dt><dd>{d.inventory.doq45}</dd></div>
                <div><dt>Current stock</dt><dd>{fmtNum(d.inventory.currentStock)}</dd></div>
                <div><dt>In-process</dt><dd>{fmtNum(d.inventory.inProgress)}</dd></div>
                <div><dt>Days of stock</dt><dd>{d.inventory.daysOfStock ?? '—'}</dd></div>
              </dl>
            ) : (
              <p className="wf-subtle">No inventory snapshot for {d.productCode ?? 'this product'}.</p>
            )
          )}

          {tab === 'cost' && (
            <>
              {/* CMTP vs standard — shown for review (the hard-block is deferred). */}
              <div className="wf-cost-param">
                <span className="wf-cost-param-head">CMTP</span>
                <dl className="wf-doc-meta">
                  <div><dt>PO CMTP</dt><dd>{fmtNum(d.poCm)}</dd></div>
                  <div><dt>Standard CMTP</dt><dd>{d.stdCm != null ? fmtNum(d.stdCm) : '— (not set)'}</dd></div>
                  <div>
                    <dt>Deviation</dt>
                    <dd className={cmDelta != null && cmDelta > 0 ? 'wf-error-text' : undefined}>
                      {cmDelta != null ? fmtNum(cmDelta) : '—'}
                      {cmDelta != null && cmDelta > 0 && ' · above standard'}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Commodity / fabric — informational only. */}
              <div className="wf-cost-param">
                <span className="wf-cost-param-head">Commodity / fabric — informational</span>
                <dl className="wf-doc-meta">
                  <div><dt>Grey (PO)</dt><dd>{fmtNum(d.poGrey)}</dd></div>
                  <div><dt>Finished fabric (PO)</dt><dd>{fmtNum(d.poFinishedFabric)}</dd></div>
                  <div>
                    <dt>vs standard fabric</dt>
                    <dd className={fabricDelta != null && fabricDelta !== 0 ? 'wf-subtle' : undefined}>
                      {d.stdFinishedFabric != null ? fmtNum(d.stdFinishedFabric) : '—'}
                      {fabricDelta != null && fabricDelta !== 0 && ` (${fabricDelta > 0 ? '+' : ''}${fmtNum(fabricDelta)})`}
                    </dd>
                  </div>
                  <div><dt>Margin %</dt><dd>{fmtNum(d.marginPct)}</dd></div>
                </dl>
                <p className="wf-subtle wf-cost-param-note">
                  Commodity moves (grey / fabric) are expected market noise — shown for awareness.
                  CMTP vs standard is shown for review.
                </p>
              </div>

              {/* Blended rate vs standard total — reference. */}
              <dl className="wf-doc-meta">
                <div><dt>Written rate</dt><dd>{fmtNum(d.writtenRate)}</dd></div>
                <div><dt>Standard total ({d.poType ?? '—'})</dt><dd>{stdForType != null ? fmtNum(stdForType) : '— (not approved)'}</dd></div>
                <div><dt>Variance</dt><dd className={variance != null && variance > 0 ? 'wf-subtle' : undefined}>{variance != null ? fmtNum(variance) : '—'}</dd></div>
              </dl>
              {d.productCode && (
                <Link className="wf-btn wf-btn-ghost wf-btn-sm" href={`/standard-cost?open=${encodeURIComponent(d.productCode)}`}>
                  Open Standard Cost →
                </Link>
              )}
            </>
          )}

          {tab === 'tna' && (
            <dl className="wf-doc-meta">
              <div><dt>Requested total days</dt><dd>{d.tna.requestedTotalDays ?? '—'}</dd></div>
              <div><dt>TNA</dt><dd>{d.tna.tnaConfirmed ? 'confirmed' : 'pending'}</dd></div>
              <div><dt>PP sample due</dt><dd>{fmtDate(d.tna.ppSampleDue)}</dd></div>
              <div><dt>GPT due</dt><dd>{fmtDate(d.tna.gptDue)}</dd></div>
              <div><dt>Cutting start</dt><dd>{fmtDate(d.tna.cuttingStart)}</dd></div>
              <div><dt>Inline QC due</dt><dd>{fmtDate(d.tna.inlineQcDue)}</dd></div>
              <div><dt>First delivery</dt><dd>{fmtDate(d.tna.firstDelivery)}</dd></div>
              <div><dt>PO closing</dt><dd>{fmtDate(d.tna.poClosingDate)}</dd></div>
            </dl>
          )}

          {tab === 'vendor' && (
            <dl className="wf-doc-meta">
              <div><dt>In process (live)</dt><dd>{inproc == null ? 'No open POs' : fmtNum(inproc)}</dd></div>
              <div><dt>Capacity / month</dt><dd>{cap == null ? 'Not logged' : fmtNum(cap)}</dd></div>
              <div><dt>Headroom</dt><dd className={headroom != null && headroom < 0 ? 'wf-error-text' : undefined}>{headroom != null ? fmtNum(headroom) : '—'}</dd></div>
              <div><dt>Updated</dt><dd>{fmtDate(item.vendorCapacityUpdatedAt)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}
