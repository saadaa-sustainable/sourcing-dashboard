'use client';

import { useMemo, useState, useTransition } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { refreshAdjustmentAction } from '@/lib/adjustments-actions';
import { REFRESH_LIMIT_PER_HOUR, type AdjustmentSource } from '@/lib/adjustments-types';
import { FilterTable, type Column } from '@/components/filter-table';

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
  source,
  cols,
  initialRows,
  initialRemaining,
  initialRetry,
}: {
  source: AdjustmentSource;
  cols: Col[];
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

  const columns = useMemo<Column<Row>[]>(
    () =>
      cols.map((c) => ({
        key: c.key,
        label: c.label,
        kind: c.num ? 'num' : 'text',
        render: c.kind ? (r: Row) => fmt(r[c.key], c.kind) : undefined,
        filter: c.kind === 'link' ? 'none' : undefined,
      })),
    [cols],
  );

  return (
    <div className="wf-stack">
      {error && <div className="wf-notice wf-notice-error">{error}</div>}
      {note && <div className="wf-notice wf-notice-ok">{note}</div>}
      <FilterTable
        rows={rows}
        columns={columns}
        rowKey={(_, i) => `${source}-${i}`}
        unit="entries"
        searchPlaceholder="Search entries…"
        emptyText="No rows yet — the sync hasn’t loaded this feed."
        toolbarExtra={
          <>
            <button type="button" className="wf-btn wf-btn-ghost" onClick={onRefresh} disabled={disabled}>
              <RefreshCw size={15} className={pending ? 'spin' : undefined} />
              {pending ? 'Refreshing…' : 'Refresh'}
            </button>
            <span className="wf-subtle" style={{ fontSize: 11 }}>
              {remaining}/{REFRESH_LIMIT_PER_HOUR} refreshes left this hour
              {remaining <= 0 && retry > 0 ? ` · retry in ~${retry} min` : ''}
            </span>
          </>
        }
      />
    </div>
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
  const [tab, setTab] = useState<AdjustmentSource>('po');

  return (
    <div className="wf-stack">
      <div className="wf-notice wf-notice-info">
        <strong>Ingest the data from here:</strong>{' '}
        <a href={portalUrl} target="_blank" rel="noopener noreferrer">
          Ingestion portal <ExternalLink size={12} style={{ verticalAlign: '-1px' }} />
        </a>
        {' '}— entries made there are synced into these tables. Hit <strong>Refresh</strong> to pull
        the newest synced rows — up to {REFRESH_LIMIT_PER_HOUR}× per hour per table.
      </div>
      <div className="segment">
        <button className={tab === 'po' ? 'active' : ''} onClick={() => setTab('po')}>
          PO Manual Adjustment
        </button>
        <button className={tab === 'cutting' ? 'active' : ''} onClick={() => setTab('cutting')}>
          Cutting Register Adjustment
        </button>
      </div>
      {/* Both panels stay mounted so tab switches keep filters and refreshed rows. */}
      <div hidden={tab !== 'po'}>
        <Panel
          source="po"
          cols={MANUAL_COLS}
          initialRows={manualRows}
          initialRemaining={manualState.remaining}
          initialRetry={manualState.retryAfterMinutes}
        />
      </div>
      <div hidden={tab !== 'cutting'}>
        <Panel
          source="cutting"
          cols={CUTTING_COLS}
          initialRows={cuttingRows}
          initialRemaining={cuttingState.remaining}
          initialRetry={cuttingState.retryAfterMinutes}
        />
      </div>
    </div>
  );
}
