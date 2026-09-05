'use client';

import { Notice } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type { SyncStatusRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN');

// How long each pipeline may go between refreshes before it counts as stale.
const STALE_AFTER_HOURS: Record<string, number> = {
  'Google Sheet - ~5 min': 1,
  'BigQuery - daily 6 AM': 30,
  'BigQuery - 6 AM & 6 PM': 15,
  'EasyEcom API': 30,
};

function ago(iso: string | null): { label: string; title: string } {
  if (!iso) return { label: '—', title: 'No sync timestamp on this source' };
  const then = new Date(iso);
  const min = Math.floor((Date.now() - then.getTime()) / 60000);
  let label: string;
  if (min < 1) label = 'just now';
  else if (min < 60) label = `${min}m ago`;
  else if (min < 1440) label = `${Math.floor(min / 60)}h ago`;
  else label = `${Math.floor(min / 1440)}d ago`;
  return { label, title: then.toLocaleString() };
}

type Health = 'fresh' | 'stale' | 'unknown';
function health(row: SyncStatusRow): Health {
  if (!row.last_refreshed) return 'unknown';
  const hours = (Date.now() - new Date(row.last_refreshed).getTime()) / 3.6e6;
  return hours <= (STALE_AFTER_HOURS[row.pipeline] ?? 30) ? 'fresh' : 'stale';
}

const BADGE: Record<Health, { text: string; bg: string; fg: string }> = {
  fresh: { text: 'Fresh', bg: '#ecf1e9', fg: '#4f7c4d' },
  stale: { text: 'Stale', bg: '#fdecea', fg: '#c0392b' },
  unknown: { text: 'Unknown', bg: '#f0ede6', fg: '#6e695e' },
};

const COLS: Column<SyncStatusRow>[] = [
  { key: 'source', label: 'Source' },
  {
    key: 'fetched_from',
    label: 'Fetched from',
    info: 'The exact object this source pulls: BigQuery table (MAPLEMONK dataset), Google Sheet tab, or API endpoint — and the Supabase table it lands in.',
    render: (r) => r.fetched_from ?? '—',
  },
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'rows', label: 'Rows', kind: 'num' },
  {
    key: 'last_refreshed',
    label: 'Last refreshed',
    // Sort chronologically on the raw timestamp; show the friendly "ago" label.
    accessor: (r) => r.last_refreshed ?? '',
    render: (r) => {
      const t = ago(r.last_refreshed);
      return <span title={t.title}>{t.label}</span>;
    },
  },
  {
    key: 'status',
    label: 'Status',
    info: 'Fresh = refreshed within its expected window. Google Sheets stale after 1h; twice-daily BigQuery (GRN) after 15h; daily BigQuery / EasyEcom after 30h. Unknown = the source carries no sync timestamp.',
    accessor: (r) => BADGE[health(r)].text,
    render: (r) => {
      const b = BADGE[health(r)];
      return (
        <span style={{ background: b.bg, color: b.fg, padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600 }}>
          {b.text}
        </span>
      );
    },
  },
];

export function SyncStatusClient({ rows }: { rows: SyncStatusRow[] }) {
  const stale = rows.filter((r) => health(r) === 'stale');

  return (
    <>
      {stale.length > 0 ? (
        <Notice tone="warn">
          <strong>{stale.length} source{stale.length > 1 ? 's are' : ' is'} stale:</strong>{' '}
          {stale.map((r) => `${r.source} (${ago(r.last_refreshed).label})`).join(' · ')}. Its
          scheduled sync may have failed — check the cron / API job.
        </Notice>
      ) : (
        <Notice tone="ok">All data sources are fresh.</Notice>
      )}

      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.source}
        unit="sources"
        searchPlaceholder="Source, pipeline…"
        emptyText="No sources reported."
        download={{ filename: 'sync-health' }}
      />
    </>
  );
}
