'use client';

import { useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Pencil, Plus, Save, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import {
  createUserLogin,
  deleteCustomRole,
  saveCustomRole,
  saveUser,
  setUserRoles,
} from '@/lib/forms/actions';
import { Field, Notice } from '@/components/forms/form-layout';
import { ROLE_LABEL } from '@/lib/forms/approval';
import { ALL_VIEWS, VIEW_GROUPS } from '@/lib/views';
import type { SdCustomRole, SdRole, SdUser } from '@/lib/forms/types';

const ROLES: SdRole[] = ['admin', 'team', 'viewer'];

type ActionFn = (fd: FormData) => Promise<{ ok: true; message?: string } | { ok: false; error: string }>;

export function UsersClient({
  users,
  roles,
  currentEmail,
  canCreateLogins,
}: {
  users: SdUser[];
  roles: SdCustomRole[];
  currentEmail: string;
  canCreateLogins: boolean;
}) {
  const [tab, setTab] = useState<'members' | 'roles'>('members');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function submit(payload: FormData, action: ActionFn = saveUser, reloadOnOk = true) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        if (reloadOnOk) reloadWithToast();
      } else {
        setError(result.error);
      }
    });
  }

  const active = users.filter((u) => u.is_active);
  const admins = active.filter((u) => u.role === 'admin');

  return (
    <>
      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {/* Team & access summary — the reference UI's stat strip. */}
      <div className="metric-grid wf-metric-grid">
        <div className="metric-card tone-purple">
          <span className="metric-label">Members</span>
          <strong>{users.length}</strong>
        </div>
        <div className="metric-card tone-teal">
          <span className="metric-label">Active</span>
          <strong>{active.length}</strong>
        </div>
        <div className="metric-card tone-orange">
          <span className="metric-label">Admins</span>
          <strong>{admins.length}</strong>
        </div>
        <div className="metric-card tone-blue">
          <span className="metric-label">Roles</span>
          <strong>{roles.length}</strong>
        </div>
      </div>

      <div className="wf-toolbar">
        <div className="segment wf-segment">
          <button
            type="button"
            className={tab === 'members' ? 'active' : ''}
            onClick={() => setTab('members')}
          >
            <Users size={14} /> Members ({users.length})
          </button>
          <button
            type="button"
            className={tab === 'roles' ? 'active' : ''}
            onClick={() => setTab('roles')}
          >
            <ShieldCheck size={14} /> Roles &amp; Permissions ({roles.length})
          </button>
        </div>
      </div>

      {tab === 'members' ? (
        <MembersTab
          users={users}
          roles={roles}
          currentEmail={currentEmail}
          canCreateLogins={canCreateLogins}
          pending={pending}
          submit={submit}
        />
      ) : (
        <RolesTab roles={roles} pending={pending} submit={submit} />
      )}
    </>
  );
}

/* ================================================================== */
/* Members                                                             */
/* ================================================================== */

function MembersTab({
  users,
  roles,
  currentEmail,
  canCreateLogins,
  pending,
  submit,
}: {
  users: SdUser[];
  roles: SdCustomRole[];
  currentEmail: string;
  canCreateLogins: boolean;
  pending: boolean;
  submit: (fd: FormData, action?: ActionFn, reloadOnOk?: boolean) => void;
}) {
  const [draft, setDraft] = useState({
    email: '',
    full_name: '',
    role: 'team' as SdRole,
    password: '',
  });
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
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
      submit(fd);
    }
  }

  return (
    <>
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
          <Field label="Access level">
            <select
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value as SdRole })}
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
          The access level is the approval ladder (admin approves everything, team
          fills forms and signs off routine items). Which pages a person sees is
          driven by the roles you assign in the table — none assigned means they
          see every non-admin page.{' '}
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
                <th>Access level</th>
                <th>Roles (views)</th>
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
                  roles={roles}
                  isSelf={user.email === currentEmail}
                  pending={pending}
                  onSave={(role, isActive, roleIds, rolesDirty) => {
                    const fd = new FormData();
                    fd.set('email', user.email);
                    fd.set('full_name', user.full_name ?? '');
                    fd.set('role', role);
                    fd.set('is_active', String(isActive));
                    if (rolesDirty) {
                      // Save base fields first (no reload), then the role set.
                      submit(fd, saveUser, false);
                      const rfd = new FormData();
                      rfd.set('email', user.email);
                      rfd.set('role_ids', JSON.stringify(roleIds));
                      submit(rfd, setUserRoles);
                    } else {
                      submit(fd);
                    }
                  }}
                />
              ))}
              {!users.length && (
                <tr>
                  <td colSpan={7} className="wf-empty-cell">
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
  roles,
  isSelf,
  pending,
  onSave,
}: {
  user: SdUser;
  roles: SdCustomRole[];
  isSelf: boolean;
  pending: boolean;
  onSave: (role: SdRole, isActive: boolean, roleIds: number[], rolesDirty: boolean) => void;
}) {
  const [role, setRole] = useState<SdRole>(user.role);
  const [active, setActive] = useState(user.is_active);
  const [roleIds, setRoleIds] = useState<Set<number>>(new Set(user.custom_role_ids ?? []));
  const savedIds = new Set(user.custom_role_ids ?? []);
  const rolesDirty =
    roleIds.size !== savedIds.size || [...roleIds].some((id) => !savedIds.has(id));
  const dirty = role !== user.role || active !== user.is_active || rolesDirty;
  const lastSeen = formatLastSeen(user.last_seen_at);

  function toggleRole(id: number) {
    setRoleIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

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
        {role === 'admin' ? (
          <span className="wf-subtle">All views (admin)</span>
        ) : roles.length ? (
          <div className="wf-role-chips">
            {roles.map((r) => (
              <label key={r.id} className={`wf-role-chip${roleIds.has(r.id) ? ' on' : ''}`}>
                <input
                  type="checkbox"
                  checked={roleIds.has(r.id)}
                  onChange={() => toggleRole(r.id)}
                />
                {r.name}
              </label>
            ))}
          </div>
        ) : (
          <span className="wf-subtle">No roles defined yet</span>
        )}
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
          onClick={() => onSave(role, active, [...roleIds], rolesDirty)}
        >
          <Save size={14} /> Save
        </button>
      </td>
    </tr>
  );
}

/* ================================================================== */
/* Roles & permissions                                                 */
/* ================================================================== */

function RolesTab({
  roles,
  pending,
  submit,
}: {
  roles: SdCustomRole[];
  pending: boolean;
  submit: (fd: FormData, action?: ActionFn, reloadOnOk?: boolean) => void;
}) {
  // null = closed, 0 = creating, otherwise the role id being edited.
  const [editing, setEditing] = useState<number | null>(null);

  return (
    <>
      <div className="wf-toolbar">
        <span className="wf-subtle">
          A role is a named set of views. Assign several roles to one person —
          they see the union of the views.
        </span>
        <button
          type="button"
          className="wf-btn wf-btn-primary"
          onClick={() => setEditing(0)}
          disabled={pending}
        >
          <Plus size={15} /> Create role
        </button>
      </div>

      {editing != null && (
        <RoleEditor
          role={editing === 0 ? null : roles.find((r) => r.id === editing) ?? null}
          pending={pending}
          onCancel={() => setEditing(null)}
          onSave={(fd) => {
            submit(fd, saveCustomRole);
            setEditing(null);
          }}
        />
      )}

      <div className="wf-role-cards">
        {roles.map((role) => (
          <article key={role.id} className="wf-role-card">
            <div className="wf-queue-head">
              <div>
                <h3>{role.name}</h3>
                <p className="wf-subtle">{role.description || 'No description'}</p>
              </div>
            </div>
            <dl className="wf-queue-meta">
              <div>
                <dt>Views</dt>
                <dd>
                  {role.pages.length} / {ALL_VIEWS.length}
                </dd>
              </div>
              <div>
                <dt>Assigned</dt>
                <dd>{role.members?.length ?? 0} user(s)</dd>
              </div>
            </dl>
            {role.pages.length > 0 && (
              <p className="wf-subtle wf-role-pages">
                {role.pages
                  .map((p) => ALL_VIEWS.find((v) => v.path === p)?.label ?? p)
                  .slice(0, 4)
                  .join(' · ')}
                {role.pages.length > 4 && ` +${role.pages.length - 4}`}
              </p>
            )}
            <div className="wf-queue-foot">
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => setEditing(role.id)}
                disabled={pending}
              >
                <Pencil size={14} /> Tune views
              </button>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => {
                  if (!window.confirm(`Delete role "${role.name}"? ${role.members?.length ?? 0} assignment(s) will be removed.`)) return;
                  const fd = new FormData();
                  fd.set('id', String(role.id));
                  submit(fd, deleteCustomRole);
                }}
                disabled={pending}
              >
                <Trash2 size={14} /> Delete
              </button>
            </div>
          </article>
        ))}
        {!roles.length && editing == null && (
          <div className="empty-state">
            <ShieldCheck size={28} />
            <p>No custom roles yet. Create the first one — e.g. “Merchandiser” with the buying and PO views.</p>
          </div>
        )}
      </div>
    </>
  );
}

function RoleEditor({
  role,
  pending,
  onCancel,
  onSave,
}: {
  role: SdCustomRole | null;
  pending: boolean;
  onCancel: () => void;
  onSave: (fd: FormData) => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [pages, setPages] = useState<Set<string>>(new Set(role?.pages ?? []));

  function toggle(path: string) {
    setPages((cur) => {
      const next = new Set(cur);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function save() {
    const fd = new FormData();
    if (role) fd.set('id', String(role.id));
    fd.set('name', name);
    fd.set('description', description);
    fd.set('pages', JSON.stringify([...pages]));
    onSave(fd);
  }

  return (
    <div className="wf-form-panel">
      <div className="wf-form-grid">
        <Field label="Role name">
          <input
            placeholder="e.g. Merchandiser"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Description">
          <input
            placeholder="What this role is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>

      {VIEW_GROUPS.map((group) => {
        const views = ALL_VIEWS.filter((v) => v.group === group);
        const allOn = views.every((v) => pages.has(v.path));
        return (
          <div key={group} className="wf-view-group">
            <label className="wf-view-group-head">
              <input
                type="checkbox"
                checked={allOn}
                onChange={() =>
                  setPages((cur) => {
                    const next = new Set(cur);
                    views.forEach((v) => (allOn ? next.delete(v.path) : next.add(v.path)));
                    return next;
                  })
                }
              />
              <strong>{group}</strong>
            </label>
            <div className="wf-view-grid">
              {views.map((v) => (
                <label key={v.path} className={`wf-role-chip${pages.has(v.path) ? ' on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={pages.has(v.path)}
                    onChange={() => toggle(v.path)}
                  />
                  {v.label}
                  {v.adminOnly && <small title="Also requires the admin access level"> ⚿</small>}
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <p className="wf-subtle">
        ⚿ marked views additionally require the admin access level — granting them
        to a non-admin has no effect. The dashboard itself is always visible.
      </p>

      <div className="wf-queue-foot">
        <button type="button" className="wf-btn wf-btn-ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className="wf-btn wf-btn-primary"
          onClick={save}
          disabled={pending || !name.trim()}
        >
          <Save size={14} /> {role ? 'Save role' : 'Create role'} ({pages.size} views)
        </button>
      </div>
    </div>
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
