'use client';

import { useMemo, useState } from 'react';
import { Search, Users } from 'lucide-react';

export type UserStatus = 'Active' | 'Confirmed' | 'Invited' | 'Pending';

export type UserRow = {
  id: string;
  email: string;
  status: UserStatus;
  createdAt: string;
  lastSignInAt: string | null;
};

const statusBadge: Record<UserStatus, string> = { Active: 'success', Confirmed: 'success', Invited: 'info', Pending: 'danger' };
const fmtDate = (value: string | null) => {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export function UserTable({ users }: { users: UserRow[] }) {
  const [search, setSearch] = useState('');
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? users.filter((u) => u.email.toLowerCase().includes(q)) : users;
  }, [users, search]);

  return <section className="panel table-panel">
    <div className="table-meta">
      <span>{rows.length} of {users.length} {users.length === 1 ? 'user' : 'users'}</span>
      <label className="search-field" style={{ minWidth: 240 }}><Search size={16} /><input placeholder="Search by email" value={search} onChange={(e) => setSearch(e.target.value)} /></label>
    </div>
    {rows.length ? <div className="table-scroll" style={{ maxHeight: 560 }}>
      <table>
        <thead><tr><th>Email</th><th>Status</th><th>Created</th><th>Last sign in</th></tr></thead>
        <tbody>{rows.map((u) => <tr key={u.id}>
          <td className="mono">{u.email}</td>
          <td><span className={`badge ${statusBadge[u.status]}`}>{u.status}</span></td>
          <td>{fmtDate(u.createdAt)}</td>
          <td>{fmtDate(u.lastSignInAt)}</td>
        </tr>)}</tbody>
      </table>
    </div> : <div className="empty-state"><Users size={28} /><p>{search ? 'No users match your search' : 'No users yet'}</p></div>}
  </section>;
}
