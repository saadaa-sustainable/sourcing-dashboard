import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRuleRows,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { RulesMasterClient } from './rules-master-client';

export const dynamic = 'force-dynamic';

export default async function RulesMasterPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Rules Master" active="/rules-master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const rules = await loadAnalyticsRuleRows();

  return (
    <FormLayout
      title="Rules Master"
      subtitle="Every judgement threshold the dashboard cards read — edited here, not hardcoded. A change takes effect on the next page load, no redeploy."
      active="/rules-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <RulesMasterClient rules={rules} role={user.role} />
    </FormLayout>
  );
}
