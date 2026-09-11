'use client';

import { FilterTable, type Column } from '@/components/filter-table';
import type { AdoptionData, AdoptionUser } from '@/lib/forms/queries-modules/adoption';

const rel = (iso: string | null) => {
  if (!iso) return 'never';
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
};

// active ≤7d · dormant >7d · never = no login on record.
function statusOf(u: AdoptionUser): { label: string; tone: string } {
  if (u.days_since == null) return { label: 'never', tone: 'wf-error-text' };
  if (u.days_since <= 7) return { label: 'active', tone: 'wf-ok-text' };
  return { label: `dormant ${u.days_since}d`, tone: 'wf-warn-text' };
}

const USER_COLS: Column<AdoptionUser>[] = [
  { key: 'name', label: 'Person', accessor: (u) => u.full_name || u.email, render: (u) => (
    <span><strong>{u.full_name || u.email.split('@')[0]}</strong><br /><span className="wf-subtle" style={{ fontSize: 11 }}>{u.email}</span></span>
  ) },
  { key: 'role', label: 'Role', render: (u) => u.role },
  { key: 'last_seen', label: 'Last login', accessor: (u) => u.last_seen_at ?? '', render: (u) => rel(u.last_seen_at) },
  {
    key: 'status', label: 'Status', accessor: (u) => u.days_since ?? 99999,
    render: (u) => { const s = statusOf(u); return <span className={s.tone}>{s.label}</span>; },
  },
  { key: 'actions_7d', label: 'Actions 7d', kind: 'num', render: (u) => String(u.actions_7d) },
  { key: 'actions_30d', label: 'Actions 30d', kind: 'num', render: (u) => String(u.actions_30d) },
  { key: 'last_action', label: 'Last action', accessor: (u) => u.last_action_at ?? '', render: (u) => rel(u.last_action_at) },
  { key: 'active', label: 'Enabled', accessor: (u) => (u.is_active ? 1 : 0), render: (u) => (u.is_active ? 'yes' : <span className="wf-subtle">disabled</span>) },
];

export function AdoptionClient({ data }: { data: AdoptionData }) {
  const active = data.users.filter((u) => u.is_active);
  const seen7 = active.filter((u) => u.days_since != null && u.days_since <= 7).length;
  const notSeen = active.filter((u) => u.days_since == null || u.days_since > 7);
  const zeroModules = data.modules.filter((m) => m.entries_7d === 0);

  return (
    <div className="wf-stack">
      {/* Summary */}
      <div className="wf-form-grid">
        <div className="wf-card wf-pad-sm"><div className="wf-subtle">Active users</div><div style={{ fontSize: 26, fontWeight: 700 }}>{active.length}</div></div>
        <div className="wf-card wf-pad-sm"><div className="wf-subtle">Logged in (7d)</div><div style={{ fontSize: 26, fontWeight: 700 }}>{seen7}</div></div>
        <div className="wf-card wf-pad-sm"><div className="wf-subtle">Not seen (7d+)</div><div style={{ fontSize: 26, fontWeight: 700 }} className={notSeen.length ? 'wf-warn-text' : undefined}>{notSeen.length}</div></div>
        <div className="wf-card wf-pad-sm"><div className="wf-subtle">Modules w/ 0 entries (7d)</div><div style={{ fontSize: 26, fontWeight: 700 }} className={zeroModules.length ? 'wf-warn-text' : undefined}>{zeroModules.length}</div></div>
      </div>

      {notSeen.length > 0 && (
        <div className="wf-notice wf-notice-info">
          <strong>Not logged in this week:</strong>{' '}
          {notSeen.map((u) => `${u.full_name || u.email}${u.days_since == null ? ' (never)' : ` (${u.days_since}d)`}`).join(', ')}
        </div>
      )}

      {/* Per-user table */}
      <div>
        <div className="wf-card-title wf-table-head">Users — login &amp; activity</div>
        <FilterTable
          rows={data.users}
          columns={USER_COLS}
          rowKey={(u) => u.email}
          unit="users"
          searchPlaceholder="name, email, role…"
          emptyText="No users."
          download={{ filename: 'adoption-users' }}
        />
      </div>

      {/* Per-module entries */}
      <div>
        <div className="wf-card-title wf-table-head">Entries by module</div>
        <div className="table-panel wf-grid-panel">
          <div className="table-scroll">
            <table className="wf-grid">
              <thead>
                <tr><th>Module</th><th className="num">Entries 7d</th><th className="num">Entries 30d</th></tr>
              </thead>
              <tbody>
                {data.modules.map((m) => (
                  <tr key={m.key}>
                    <td>{m.label}{m.entries_7d === 0 && <span className="wf-warn-text"> · ⚠ none this week</span>}</td>
                    <td className="num">{m.entries_7d}</td>
                    <td className="num">{m.entries_30d}</td>
                  </tr>
                ))}
                {!data.modules.length && <tr><td colSpan={3} className="wf-empty-cell">No activity recorded.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <p className="wf-subtle wf-pad-sm">
        Login = last time each person opened the dashboard (any page). Actions = workflow steps in the
        activity log (proposals, approvals, sign-offs, PO issuance, closures…). Generated {rel(data.generatedAt)}.
      </p>
    </div>
  );
}
