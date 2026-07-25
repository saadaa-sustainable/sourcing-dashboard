import { LogOut } from 'lucide-react';
import { SideNav } from '@/components/side-nav';
import { signOut } from '@/lib/auth-actions';
import { ROLE_LABEL, STATUS_LABEL, STATUS_TONE } from '@/lib/forms/approval';
import type { SdRole, SdStatus } from '@/lib/forms/types';

export function FormLayout({
  title,
  subtitle,
  active,
  role,
  userEmail = null,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  active: string;
  role: SdRole;
  userEmail?: string | null;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <SideNav activeWorkflow={active} userEmail={userEmail} />
      <main>
        <div className="wf-page">
          <header className="wf-head">
            <div>
              <h1>{title}</h1>
              {subtitle && <p className="wf-sub">{subtitle}</p>}
            </div>
            <div className="wf-head-actions">
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
          <div className="wf-body">{children}</div>
        </div>
      </main>
    </div>
  );
}

export function StatusBadge({ status }: { status: SdStatus }) {
  return (
    <span className={`wf-status tone-${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
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
