'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { canApprove, ROLE_LABEL, STATUS_LABEL } from '@/lib/forms/approval';
import { StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type { ApprovalLogRow, ApprovalQueueItem, SdRole } from '@/lib/forms/types';

export function ApprovalsClient({
  items,
  log,
  role,
}: {
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
  role: SdRole;
}) {
  const [filter, setFilter] = useState<'all' | 'mine'>('mine');

  const mine = items.filter((item) => canApprove(role, item.status));
  const shown = filter === 'mine' ? mine : items;

  return (
    <>
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
            </dl>
            <div className="wf-queue-foot">
              <Link href={item.href} className="wf-btn wf-btn-ghost">
                Open record
              </Link>
              {canApprove(role, item.status) && (
                <ApprovalBar
                  entityType={item.entityType}
                  entityId={item.entityId}
                  entityLabel={item.label}
                  onDone={(result) => {
                    if (result.ok) window.location.reload();
                  }}
                />
              )}
            </div>
          </article>
        ))}
        {!shown.length && (
          <div className="empty-state">
            <ShieldCheck size={28} />
            <p>Nothing waiting on you.</p>
          </div>
        )}
      </div>

      <div className="table-panel">
        <div className="table-meta">
          <h3>Approval history</h3>
          <span>Last {log.length} decisions</span>
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
              {log.map((row) => (
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
              {!log.length && (
                <tr>
                  <td colSpan={5} className="wf-empty-cell">
                    No decisions recorded yet.
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
