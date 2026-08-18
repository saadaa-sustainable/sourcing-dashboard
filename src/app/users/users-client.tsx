'use client';

import { useState, useTransition } from 'react';
import { Save, UserPlus } from 'lucide-react';
import { createUserLogin, saveUser } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { ROLE_LABEL } from '@/lib/forms/approval';
import type { SdRole, SdUser } from '@/lib/forms/types';

const ROLES: SdRole[] = ['admin', 'team', 'viewer'];

export function UsersClient({
  users,
  currentEmail,
  canCreateLogins,
}: {
  users: SdUser[];
  currentEmail: string;
  canCreateLogins: boolean;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState({
    email: '',
    full_name: '',
    role: 'team' as SdRole,
    password: '',
  });

  function submit(
    payload: FormData,
    action: (fd: FormData) => Promise<{ ok: true; message?: string } | { ok: false; error: string }> = saveUser,
    reloadOnOk = true,
  ) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        if (reloadOnOk) window.location.reload();
      } else {
        setError(result.error);
      }
    });
  }

  function addUser() {
    if (!draft.email.trim()) {
      setError('Enter an email address.');
      return;
    }
    const wantsLogin = draft.password.length > 0;
    if (wantsLogin && draft.password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    const fd = new FormData();
    fd.set('email', draft.email);
    fd.set('full_name', draft.full_name);
    fd.set('role', draft.role);
    fd.set('is_active', 'true');
    // A password provisions an email+password login via the Admin API; without
    // one we only set the role (for people who sign in with Google).
    if (wantsLogin) {
      fd.set('password', draft.password);
      submit(fd, createUserLogin);
    } else {
      submit(fd, saveUser);
    }
  }

  return (
    <>
      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="wf-form-panel">
        <div className="wf-form-grid">
          <Field label="Email">
            <input
              type="email"
              placeholder="name@saadaa.in"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </Field>
          <Field label="Full name">
            <input
              value={draft.full_name}
              onChange={(e) => setDraft({ ...draft, full_name: e.target.value })}
            />
          </Field>
          <Field label="Role">
            <select
              value={draft.role}
              onChange={(e) =>
                setDraft({ ...draft, role: e.target.value as SdRole })
              }
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Password (optional)">
            <input
              type="password"
              placeholder={canCreateLogins ? 'Min 8 chars — enables email login' : 'Service key not configured'}
              value={draft.password}
              autoComplete="new-password"
              disabled={!canCreateLogins}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
          </Field>
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={addUser}
            disabled={pending}
          >
            <UserPlus size={15} /> Add / update user
          </button>
        </div>
        <p className="wf-subtle" style={{ marginTop: 10 }}>
          Set a password to create an email + password login the person can use
          immediately (re-entering an existing email resets their password).
          Leave it blank to only assign a role — for people who sign in with
          Google.{' '}
          {!canCreateLogins &&
            'Password login is disabled until SUPABASE_SERVICE_ROLE_KEY is set on the server.'}
        </p>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Active</th>
                <th>Last active</th>
                <th aria-label="Save" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <UserRow
                  key={user.email}
                  user={user}
                  isSelf={user.email === currentEmail}
                  pending={pending}
                  onSave={(role, isActive) => {
                    const fd = new FormData();
                    fd.set('email', user.email);
                    fd.set('full_name', user.full_name ?? '');
                    fd.set('role', role);
                    fd.set('is_active', String(isActive));
                    submit(fd);
                  }}
                />
              ))}
              {!users.length && (
                <tr>
                  <td colSpan={6} className="wf-empty-cell">
                    No users yet. Add the first one above.
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

function UserRow({
  user,
  isSelf,
  pending,
  onSave,
}: {
  user: SdUser;
  isSelf: boolean;
  pending: boolean;
  onSave: (role: SdRole, isActive: boolean) => void;
}) {
  const [role, setRole] = useState<SdRole>(user.role);
  const [active, setActive] = useState(user.is_active);
  const dirty = role !== user.role || active !== user.is_active;
  const lastSeen = formatLastSeen(user.last_seen_at);

  return (
    <tr>
      <td className="mono">
        {user.email}
        {isSelf && <small>you</small>}
      </td>
      <td>{user.full_name ?? '—'}</td>
      <td>
        <select value={role} onChange={(e) => setRole(e.target.value as SdRole)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
        />
      </td>
      <td>
        <span className="wf-subtle" title={lastSeen.title}>
          {lastSeen.label}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="wf-btn wf-btn-ghost"
          disabled={!dirty || pending}
          onClick={() => onSave(role, active)}
        >
          <Save size={14} /> Save
        </button>
      </td>
    </tr>
  );
}

/** Friendly "last active" label (relative), with the full local time in the tooltip. */
function formatLastSeen(iso?: string | null): { label: string; title: string } {
  if (!iso) return { label: 'Never', title: 'Has not opened the dashboard yet' };
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return { label: '—', title: '' };
  const min = Math.floor((Date.now() - then.getTime()) / 60000);
  let label: string;
  if (min < 5) label = 'Just now';
  else if (min < 60) label = `${min}m ago`;
  else if (min < 60 * 24) label = `${Math.floor(min / 60)}h ago`;
  else {
    const days = Math.floor(min / (60 * 24));
    label = days < 30 ? `${days}d ago` : then.toLocaleDateString();
  }
  return { label, title: then.toLocaleString() };
}
