import { LogOut, ShieldAlert } from 'lucide-react';
import { SideNav } from '@/components/side-nav';
import { FormHelp } from '@/components/forms/form-help';
import { ApprovalsBell } from '@/components/forms/approvals-bell';
import { signOut } from '@/lib/auth-actions';
import { ROLE_LABEL, STATUS_LABEL, STATUS_TONE } from '@/lib/forms/approval';
import { canView } from '@/lib/views';
import { FeatureBadgeLive } from '@/components/feature-badge-live';
import type { SdRole, SdStatus } from '@/lib/forms/types';

export function FormLayout({
  title,
  subtitle,
  active,
  role,
  userEmail = null,
  allowedPages = null,
  actions,
  accent,
  children,
}: {
  title: string;
  subtitle?: string;
  active: string;
  role: SdRole;
  userEmail?: string | null;
  /**
   * Union of pages from the caller's custom roles (User Panel); null =
   * unrestricted. Filters the sidebar AND gates this page's content.
   */
  allowedPages?: string[] | null;
  actions?: React.ReactNode;
  // A per-screen accent so distinct processes (PO vs Standard Cost vs …) read as
  // visually different pages, not the same form.
  accent?: 'blue' | 'purple' | 'teal' | 'orange';
  children: React.ReactNode;
}) {
  const accessible = canView(active, role, allowedPages);
  return (
    <div className="app-shell">
      <SideNav activeWorkflow={active} userEmail={userEmail} role={role} allowedPages={allowedPages} />
      <main>
        <div className={`wf-page${accent ? ` wf-accent wf-accent-${accent}` : ''}`}>
          <header className="wf-head">
            <div>
              <h1 className="wf-title-row">
                {title}
                <FeatureBadgeLive path={active} />
              </h1>
              {subtitle && <p className="wf-sub">{subtitle}</p>}
            </div>
            <div className="wf-head-actions">
              <FormHelp route={active} title={title} />
              {role === 'admin' && <ApprovalsBell />}
              <span className="wf-role">{ROLE_LABEL[role]}</span>
              {actions}
              {userEmail && (
                <div className="account">
                  <span className="account-email" title={userEmail}>
                    {userEmail}
                  </span>
                  <form action={signOut}>
                    <button type="submit" className="account-signout">
                      <LogOut size={15} /> Sign out
                    </button>
                  </form>
                </div>
              )}
            </div>
          </header>
          <div className="wf-body">
            {accessible ? (
              children
            ) : (
              <div className="empty-state">
                <ShieldAlert size={28} />
                <p>
                  Your roles don&apos;t include this view. Ask an admin to grant it
                  from the User Panel.
                </p>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export function StatusBadge({ status, edited }: { status: SdStatus; edited?: boolean }) {
  // For an approved record, surface whether it went through edits (rework) or was
  // approved first time — this drives the "% of approvals that needed edits" metric.
  const label =
    status === 'approved' && edited !== undefined
      ? edited
        ? 'Edited-and-Approved'
        : 'First-Time Approved'
      : STATUS_LABEL[status];
  return <span className={`wf-status tone-${STATUS_TONE[status]}`}>{label}</span>;
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'ok';
  children: React.ReactNode;
}) {
  return <div className={`wf-notice wf-notice-${tone}`}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field wf-field">
      <span>
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}
