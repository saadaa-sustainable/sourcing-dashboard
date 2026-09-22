'use client';

import { useMemo, useState, useTransition } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { refreshAdjustmentAction } from '@/lib/adjustments-actions';
import { signCuttingApproval } from '@/lib/forms/actions';
import { REFRESH_LIMIT_PER_HOUR, type AdjustmentSource } from '@/lib/adjustments-types';
import { FilterTable, type Column } from '@/components/filter-table';
import { CuttingRegisterInput, CuttingBulkUpdate } from './cutting-input';
import { ManualAdjustmentInput } from './manual-adjustment-input';

type Row = Record<string, unknown>;
type Col = {
  key: string;
  label: string;
  num?: boolean;
  kind?: 'datetime' | 'date' | 'link';
  /** Force a dropdown filter (dates filter by day, not timestamp). */
  select?: boolean;
  /** ⓘ tooltip shown on the column header. */
  info?: string;
};

const MANUAL_COLS: Col[] = [
  { key: 'ingestion_date', label: 'Ingested at', kind: 'datetime', select: true, info: "WHAT: when this adjustment reached the dashboard.\n\nHOW: the time it was synced from BigQuery.\n\nUSE: an adjustment entered here today shows a later time once the push-back and sync complete." },
  { key: 'po_no', label: 'PO No', select: true },
  { key: 'sku_code', label: 'SKU' },
  { key: 'manual_adjust_qty', label: 'Adjust qty', num: true, info: "WHAT: a hand correction to a PO's quantity.\n\nHOW: pieces added (positive) or removed (negative) for this PO and SKU, over and above what EasyEcom says.\n\nUSE: for known errors in the feed — a wrong size split, a cancelled colour. Every open-PO number on the dashboard includes these." },
  { key: 'po_type', label: 'PO type' },
  { key: 'ingestion_by', label: 'By' },
];

const CUTTING_COLS: Col[] = [
  { key: 'date_of_ingestion', label: 'Ingested', kind: 'date', select: true },
  { key: 'date_of_cutting', label: 'Cut date', kind: 'date' },
  { key: 'vendor_code', label: 'Vendor' },
  { key: 'po_number', label: 'PO number', select: true },
  { key: 'item_code', label: 'Item' },
  { key: 'fabric_sku_code', label: 'Fabric SKU' },
  { key: 'cutting_qty', label: 'Cut qty', num: true, info: "WHAT: how many pieces the vendor has cut.\n\nHOW: from the cutting register entry.\n\nUSE: cut but not received = work in progress at the vendor." },
  { key: 'fabric_consumed', label: 'Fabric used', num: true, info: "WHAT: metres of fabric actually used.\n\nHOW: from the cutting register entry.\n\nUSE: compare with the benchmark beside it — over-consumption is fabric SAADAA paid for and did not get back." },
  { key: 'avg_fabric_consumption_approved', label: 'Avg cons.', num: true, info: "WHAT: metres one piece is supposed to take.\n\nHOW: the approved average from the Product Master.\n\nUSE: actual ÷ (pieces × this) above 1 means the vendor used more fabric than allowed." },
  { key: 'width_of_fabric', label: 'Width' },
  { key: 'type_of_po', label: 'PO type' },
  { key: 'remarks_of_cutting', label: 'Remarks' },
  { key: 'cutting_approval_sheet', label: 'Approval', kind: 'link', info: "WHAT: the cutting approval document.\n\nHOW: a link to the sheet for this PO line.\n\nUSE: the evidence behind the cut quantity." },
  { key: 'ingestion_by', label: 'By' },
];

/**
 * Approval-sheet cell: the value is either a full URL (portal uploads) or a Supabase
 * Storage object path (dashboard uploads, e.g. cutting/<uuid>.jpg) — the latter needs
 * a short-lived signed URL, exactly like the Cutting Register page does.
 */
function ApprovalLink({ value }: { value: string }) {
  const [busy, setBusy] = useState(false);
  if (/^https?:\/\//i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer">
        open
      </a>
    );
  }
  async function open() {
    setBusy(true);
    try {
      const res = await signCuttingApproval(value);
      if ('url' in res) window.open(res.url, '_blank', 'noopener,noreferrer');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={busy} onClick={open}>
      {busy ? '…' : 'open'}
    </button>
  );
}

function fmt(value: unknown, kind?: Col['kind']): React.ReactNode {
  if (value == null || value === '') return '—';
  if (kind === 'datetime') return String(value).replace('T', ' ').slice(0, 16);
  if (kind === 'date') return String(value).slice(0, 10);
  if (kind === 'link') return <ApprovalLink value={String(value)} />;
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
        if (res.error) setError(res.error); // ok but served from the snapshot — say so
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
        // Dates/datetimes filter and search at day granularity.
        accessor:
          c.kind === 'datetime' || c.kind === 'date'
            ? (r: Row) => (r[c.key] == null ? '' : String(r[c.key]).slice(0, 10))
            : undefined,
        render: c.kind ? (r: Row) => fmt(r[c.key], c.kind) : undefined,
        filter: c.kind === 'link' ? 'none' : c.select ? 'select' : undefined,
        info: c.info,
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
        defaultSource="bigquery"
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
  editable,
}: {
  portalUrl: string;
  manualRows: Row[];
  cuttingRows: Row[];
  manualState: { remaining: number; retryAfterMinutes: number };
  cuttingState: { remaining: number; retryAfterMinutes: number };
  editable: boolean;
}) {
  const [tab, setTab] = useState<AdjustmentSource>('po');
  const [cutMode, setCutMode] = useState<'input' | 'bulk' | 'synced'>('input');
  const [poMode, setPoMode] = useState<'input' | 'synced'>('input');

  return (
    <div className="wf-stack">
      <div className="wf-notice wf-notice-info">
        <strong>Enter data right here</strong> — use <strong>UI Input</strong> on either tab; entries
        push to the warehouse (BigQuery) automatically within ~5 minutes. <strong>Synced data</strong>{' '}
        shows what has landed; hit <strong>Refresh</strong> to pull the newest rows — up to{' '}
        {REFRESH_LIMIT_PER_HOUR}× per hour per table. The old{' '}
        <a href={portalUrl} target="_blank" rel="noopener noreferrer">
          ingestion portal <ExternalLink size={12} style={{ verticalAlign: '-1px' }} />
        </a>{' '}
        remains only for bulk cutting-register uploads.
      </div>
      <div className="segment">
        <button className={tab === 'po' ? 'active' : ''} onClick={() => setTab('po')}>
          PO Manual Adjustment
        </button>
        <button className={tab === 'cutting' ? 'active' : ''} onClick={() => setTab('cutting')}>
          Cutting Register
        </button>
      </div>
      {/* Both panels stay mounted so tab switches keep filters and refreshed rows. */}
      <div hidden={tab !== 'po'}>
        {/* PO Manual Adjustment: enter on the dashboard (UI Input — pushed to BigQuery) or view
            the data already synced back from BigQuery. */}
        <div className="segment fb-seg" style={{ marginBottom: 12 }}>
          <button className={poMode === 'input' ? 'active' : ''} onClick={() => setPoMode('input')}>UI Input</button>
          <button className={poMode === 'synced' ? 'active' : ''} onClick={() => setPoMode('synced')}>Synced data</button>
        </div>
        <div hidden={poMode !== 'input'}><ManualAdjustmentInput editable={editable} /></div>
        <div hidden={poMode !== 'synced'}>
          <Panel
            source="po"
            cols={MANUAL_COLS}
            initialRows={manualRows}
            initialRemaining={manualState.remaining}
            initialRetry={manualState.retryAfterMinutes}
          />
        </div>
      </div>
      <div hidden={tab !== 'cutting'}>
        {/* Cutting Register: enter on the dashboard (UI Input / Bulk Update) or view the
            data already synced from BigQuery. */}
        <div className="segment fb-seg" style={{ marginBottom: 12 }}>
          <button className={cutMode === 'input' ? 'active' : ''} onClick={() => setCutMode('input')}>UI Input</button>
          <button className={cutMode === 'bulk' ? 'active' : ''} onClick={() => setCutMode('bulk')}>Bulk Update</button>
          <button className={cutMode === 'synced' ? 'active' : ''} onClick={() => setCutMode('synced')}>Synced data</button>
        </div>
        <div hidden={cutMode !== 'input'}><CuttingRegisterInput editable={editable} /></div>
        <div hidden={cutMode !== 'bulk'}><CuttingBulkUpdate portalUrl={portalUrl} /></div>
        <div hidden={cutMode !== 'synced'}>
          <Panel
            source="cutting"
            cols={CUTTING_COLS}
            initialRows={cuttingRows}
            initialRemaining={cuttingState.remaining}
            initialRetry={cuttingState.retryAfterMinutes}
          />
        </div>
      </div>
    </div>
  );
}
