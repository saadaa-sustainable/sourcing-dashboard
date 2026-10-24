import Link from 'next/link';
import { ClipboardList, BarChart3, Clock3 } from 'lucide-react';
import { FormLayout } from '@/components/forms/form-layout';
import type { SdRole } from '@/lib/forms/types';
import styles from './v2.module.css';
export function ReportingShell({ title, role, email, allowedPages, children, section }: {
  title: string; role: SdRole; email?: string; allowedPages?: string[] | null; children: React.ReactNode; section: 'analytics' | 'tracker';
}) {
  return <FormLayout title={title}
    subtitle={section === 'analytics' ? 'Compare planned receipts with system GRNs by week or month.' : 'Track reported receipts, follow-ups and pending system GRNs.'} active="/inward-plan-v2" role={role} userEmail={email}
    allowedPages={allowedPages} accent="teal">
    <InwardPlanNavigation section={section} />
    <div className={styles.reportContent}>{children}</div>
  </FormLayout>;
}

export function InwardPlanNavigation({ section }: { section: 'plans' | 'analytics' | 'tracker' }) {
  return (
    <nav className={styles.reportNav} aria-label="Inward Plan navigation">
      <Link href="/inward-plan-v2" aria-current={section === 'plans' ? 'page' : undefined}><ClipboardList size={16} aria-hidden="true" />Plans</Link>
      <Link href="/inward-plan-v2/analytics" aria-current={section === 'analytics' ? 'page' : undefined}><BarChart3 size={16} aria-hidden="true" />Analytics</Link>
      <Link href="/inward-plan-v2/grn-delay-tracker" aria-current={section === 'tracker' ? 'page' : undefined}><Clock3 size={16} aria-hidden="true" />GRN Delay Tracker</Link>
    </nav>
  );
}
