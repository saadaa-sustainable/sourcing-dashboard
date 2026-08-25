'use client';

import { Notice } from '@/components/forms/form-layout';
import type { SyncStatusRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN');

// How long each pipeline may go between refreshes before it counts as stale.
const STALE_AFTER_HOURS: Record<string, number> = {
  'Google Sheet - ~5 min': 1,
  'BigQuery - daily 6 AM': 30,
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
  fresh: { text: 'Fresh', bg: '#e6f4ea', fg: '#137333' },
  stale: { text: 'Stale', bg: '#fce8e6', fg: '#c5221f' },
  unknown: { text: 'Unknown', bg: '#f1f3f4', fg: '#5f6368' },
};

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

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Source</th>
                <th>Pipeline</th>
                <th className="num">Rows</th>
                <th>Last refreshed</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const h = health(r);
                const b = BADGE[h];
                const t = ago(r.last_refreshed);
                return (
                  <tr key={r.source}>
                    <td>{r.source}</td>
                    <td className="wf-subtle">{r.pipeline}</td>
                    <td className="num">{fmt.format(r.rows)}</td>
                    <td title={t.title}>{t.label}</td>
                    <td>
                      <span
                        style={{
                          background: b.bg,
                          color: b.fg,
                          padding: '2px 8px',
                          borderRadius: 10,
                          fontSize: 12,
                          fontWeight: 600,
                        }}
                      >
                        {b.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={5} className="wf-empty-cell">
                    No sources reported.
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
