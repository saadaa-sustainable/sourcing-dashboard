'use client';

import type { ReactNode } from 'react';
import { CalendarClock, RefreshCw } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';

/**
 * The "whose data am I looking at" strip for snapshot-backed tabs (OOS, DOQ,
 * Replenishment): the BigQuery inventory-planning snapshot date + last sync.
 */
export function DataAsOf({
  dataAsOf,
  lastSynced,
  children,
}: {
  dataAsOf: string | null;
  lastSynced: string | null;
  /** Extra chips appended after the standard two (e.g. row counts). */
  children?: ReactNode;
}) {
  return (
    <div className="chip-row">
      <span className="wf-chip">
        <CalendarClock size={13} />
        Data as of <strong>{dataAsOf ?? '—'}</strong>
        <InfoDot text={"WHAT: the date the stock and demand figures on this page are as of.\n\nHOW: the latest nightly inventory-planning snapshot from BigQuery.\n\nUSE: if it is older than yesterday the sync has not run — check Sync Health before acting on the numbers."} />
      </span>
      <span className="wf-chip">
        <RefreshCw size={13} />
        Refreshed{' '}
        <strong>
          {lastSynced
            ? new Date(lastSynced).toLocaleString('en-IN', {
                day: 'numeric',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
              })
            : '—'}
        </strong>
      </span>
      {children}
    </div>
  );
}
