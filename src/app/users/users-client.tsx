'use client';

import { useState, useTransition } from 'react';
import { Save, UserPlus } from 'lucide-react';
import { saveUser } from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { ROLE_LABEL } from '@/lib/forms/approval';
import type { SdRole, SdUser } from '@/lib/forms/types';

const ROLES: SdRole[] = ['admin', 'team', 'viewer'];

export function UsersClient({
  users,
  currentEmail,
}: {
  users: SdUser[];
  currentEmail: string;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState({
    email: '',
    full_name: '',
    role: 'team' as SdRole,
  });

  function submit(payload: FormData, reloadOnOk = true) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await saveUser(payload);
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
    const fd = new FormData();
    fd.set('email', draft.email);
    fd.set('full_name', draft.full_name);
    fd.set('role', draft.role);
    fd.set('is_active', 'true');
    submit(fd);
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
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={addUser}
            disabled={pending}
          >
            <UserPlus size={15} /> Add / update user
          </button>
        </div>
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
                  <td colSpan={5} className="wf-empty-cell">
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
