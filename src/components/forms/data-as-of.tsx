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
    <div className="wf-toolbar" style={{ justifyContent: 'flex-start', gap: 12 }}>
      <span className="wf-chip">
        <CalendarClock size={13} />
        Data as of <strong>{dataAsOf ?? '—'}</strong>
        <InfoDot text="The BigQuery inventory-planning snapshot date these numbers come from (latest date_day)." />
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
