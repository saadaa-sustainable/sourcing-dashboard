import { LogOut, ShieldAlert } from 'lucide-react';
import { SideNav } from '@/components/side-nav';
import { FormHelp } from '@/components/forms/form-help';
import { ApprovalsBell } from '@/components/forms/approvals-bell';
import { FeedbackBell } from '@/components/forms/feedback-bell';
import { signOut } from '@/lib/auth-actions';
import { ROLE_LABEL, STATUS_TONE, statusText } from '@/lib/forms/approval';
import { canView } from '@/lib/views';
import { FeatureBadgeLive } from '@/components/feature-badge-live';
import { ReportButton } from '@/components/forms/report-button';
import type { SdRole, SdStatus } from '@/lib/forms/types';

const FOCUSED_UI_VIEW_CLASS: Record<string, string> = {
  '/approvals': 'ui-view-approvals',
  '/buying-plan': 'ui-view-buying-plan',
  '/discontinue': 'ui-view-discontinue',
  '/doq-dashboard': 'ui-view-oos-dashboard',
  '/po-approval': 'ui-view-po-approval',
  '/po-manual-adjustment': 'ui-view-manual-ingestion',
  '/receivable-plan': 'ui-view-receivable-plan',
  '/standard-cost': 'ui-view-standard-cost',
  '/vendor-capacity': 'ui-view-vendor-capacity',
};

export function FormLayout({
  title,
  subtitle,
  active,
  helpRoute,
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
  /** Route used for the "What do these mean?" help — defaults to `active`.
   *  Hub pages (e.g. /master) pass the active sub-route so its help still shows. */
  helpRoute?: string;
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
  const focusedUiClass = FOCUSED_UI_VIEW_CLASS[active];
  return (
    <div
      className={`app-shell ui-shopify${focusedUiClass ? ` ui-shopify-focused ${focusedUiClass}` : ''}`}
    >
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
              <FormHelp route={helpRoute ?? active} title={title} />
              {role === 'admin' && <FeedbackBell />}
              {role !== 'viewer' && <ApprovalsBell />}
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
      <ReportButton />
    </div>
  );
}

export function StatusBadge({
  status,
  edited,
  approverEdited,
}: {
  status: SdStatus;
  /** Went through a rework round before approval. */
  edited?: boolean | null;
  /** The approver changed values when approving (Edit & approve). */
  approverEdited?: boolean | null;
}) {
  // An approved record says how it got there: with the approver's edits, after rework, or
  // first time — this also drives the "% of approvals that needed edits" metric.
  return <span className={`wf-status tone-${STATUS_TONE[status]}`}>{statusText(status, { edited, approverEdited })}</span>;
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
