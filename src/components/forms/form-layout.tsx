import Link from 'next/link';
import { ArrowLeft, ClipboardCheck, Factory, ShoppingCart, Ban } from 'lucide-react';
import { ROLE_LABEL, STATUS_LABEL, STATUS_TONE } from '@/lib/forms/approval';
import type { SdRole, SdStatus } from '@/lib/forms/types';

export const WORKFLOW_LINKS = [
  { href: '/buying-plan', label: 'Buying Plan', Icon: ShoppingCart },
  { href: '/vendor-capacity', label: 'Vendor Capacity', Icon: Factory },
  { href: '/discontinue', label: 'Discontinue', Icon: Ban },
  { href: '/approvals', label: 'Approvals', Icon: ClipboardCheck },
] as const;

export function FormLayout({
  title,
  subtitle,
  active,
  role,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  active: string;
  role: SdRole;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="wf-page">
      <header className="wf-head">
        <div>
          <Link href="/" className="wf-back">
            <ArrowLeft size={15} /> Sourcing dashboard
          </Link>
          <h1>{title}</h1>
          {subtitle && <p className="wf-sub">{subtitle}</p>}
        </div>
        <div className="wf-head-actions">
          <span className="wf-role">{ROLE_LABEL[role]}</span>
          {actions}
        </div>
      </header>

      <nav className="wf-nav">
        {WORKFLOW_LINKS.map(({ href, label, Icon }) => (
          <Link key={href} href={href} className={active === href ? 'active' : ''}>
            <Icon size={15} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>

      <div className="wf-body">{children}</div>
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
