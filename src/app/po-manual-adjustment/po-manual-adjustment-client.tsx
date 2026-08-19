'use client';

import { useState, useTransition } from 'react';
import { RefreshCw } from 'lucide-react';
import { refreshAdjustmentAction } from '@/lib/adjustments-actions';
import { REFRESH_LIMIT_PER_HOUR, type AdjustmentSource } from '@/lib/adjustments-types';

type Row = Record<string, unknown>;
type Col = { key: string; label: string; num?: boolean; kind?: 'datetime' | 'date' | 'link' };

const MANUAL_COLS: Col[] = [
  { key: 'ingestion_date', label: 'Ingested at', kind: 'datetime' },
  { key: 'po_no', label: 'PO No' },
  { key: 'sku_code', label: 'SKU' },
  { key: 'manual_adjust_qty', label: 'Adjust qty', num: true },
  { key: 'po_type', label: 'PO type' },
  { key: 'ingestion_by', label: 'By' },
];

const CUTTING_COLS: Col[] = [
  { key: 'date_of_ingestion', label: 'Ingested', kind: 'date' },
  { key: 'date_of_cutting', label: 'Cut date', kind: 'date' },
  { key: 'vendor_code', label: 'Vendor' },
  { key: 'po_number', label: 'PO number' },
  { key: 'item_code', label: 'Item' },
  { key: 'fabric_sku_code', label: 'Fabric SKU' },
  { key: 'cutting_qty', label: 'Cut qty', num: true },
  { key: 'fabric_consumed', label: 'Fabric used', num: true },
  { key: 'avg_fabric_consumption_approved', label: 'Avg cons.', num: true },
  { key: 'width_of_fabric', label: 'Width' },
  { key: 'type_of_po', label: 'PO type' },
  { key: 'remarks_of_cutting', label: 'Remarks' },
  { key: 'cutting_approval_sheet', label: 'Approval', kind: 'link' },
  { key: 'ingestion_by', label: 'By' },
];

function fmt(value: unknown, kind?: Col['kind']): React.ReactNode {
  if (value == null || value === '') return '—';
  if (kind === 'datetime') return String(value).replace('T', ' ').slice(0, 16);
  if (kind === 'date') return String(value).slice(0, 10);
  if (kind === 'link') {
    return (
      <a href={String(value)} target="_blank" rel="noopener noreferrer">
        open
      </a>
    );
  }
  return String(value);
}

function Panel({
  title,
  source,
  cols,
  wide,
  initialRows,
  initialRemaining,
  initialRetry,
}: {
  title: string;
  source: AdjustmentSource;
  cols: Col[];
  wide?: boolean;
  initialRows: Row[];
  initialRemaining: number;
  initialRetry: number;
}) {
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [remaining, setRemaining] = useState(initialRemaining);
  const [retry, setRetry] = useState(initialRetry);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const disabled = pending || remaining <= 0;

  function onRefresh() {
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await refreshAdjustmentAction(source);
      setRemaining(res.remaining);
      setRetry(res.retryAfterMinutes);
      if (res.ok) {
        setRows(res.rows);
        setNote(`Reloaded · ${res.rows.length} rows · ${res.remaining} refresh${res.remaining === 1 ? '' : 'es'} left this hour`);
      } else {
        setError(res.error ?? 'Refresh failed.');
      }
    });
  }

  return (
    <section className="table-panel wf-grid-panel">
      <div className="table-meta">
        <div className="adj-panel-head">
          <h3>{title}</h3>
          <span className="wf-chip">{rows.length} rows</span>
          <span className="table-meta-note">
            latest by ingestion · {remaining}/{REFRESH_LIMIT_PER_HOUR} refreshes left this hour
            {remaining <= 0 && retry > 0 ? ` · retry in ~${retry} min` : ''}
          </span>
        </div>
        <div className="table-meta-actions">
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onRefresh} disabled={disabled}>
            <RefreshCw size={15} className={pending ? 'spin' : undefined} />
            {pending ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error && <div className="wf-notice wf-notice-error">{error}</div>}
      {note && <div className="wf-notice wf-notice-ok">{note}</div>}
      <div className={wide ? 'table-scroll wide-table' : 'table-scroll'}>
        <table className="wf-grid">
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c.key} className={c.num ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((r, i) => (
                <tr key={i}>
                  {cols.map((c) => (
                    <td key={c.key} className={c.num ? 'num' : undefined}>
                      {fmt(r[c.key], c.kind)}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={cols.length} className="wf-empty">
                  No rows yet — the sync hasn’t loaded this feed.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function PoManualAdjustmentClient({
  portalUrl,
  manualRows,
  cuttingRows,
  manualState,
  cuttingState,
}: {
  portalUrl: string;
  manualRows: Row[];
  cuttingRows: Row[];
  manualState: { remaining: number; retryAfterMinutes: number };
  cuttingState: { remaining: number; retryAfterMinutes: number };
}) {
  return (
    <div className="wf-stack">
      <div className="wf-notice wf-notice-info">
        Adjustments are entered in the{' '}
        <a href={portalUrl} target="_blank" rel="noopener noreferrer">
          ingestion portal
        </a>{' '}
        (also the button top-right); the sync loads them here. Hit <strong>Refresh</strong> on a table
        to pull the newest synced rows — up to {REFRESH_LIMIT_PER_HOUR}× per hour each.
      </div>
      <Panel
        title="Manual Adjustment (PO)"
        source="po"
        cols={MANUAL_COLS}
        initialRows={manualRows}
        initialRemaining={manualState.remaining}
        initialRetry={manualState.retryAfterMinutes}
      />
      <Panel
        title="Cutting Register"
        source="cutting"
        cols={CUTTING_COLS}
        wide
        initialRows={cuttingRows}
        initialRemaining={cuttingState.remaining}
        initialRetry={cuttingState.retryAfterMinutes}
      />
    </div>
  );
}
