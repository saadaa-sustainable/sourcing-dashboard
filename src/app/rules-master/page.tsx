import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRuleRows,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { loadBuyingPlanApprovalRule } from '@/lib/buying-plan-approval.server';
import { client, pageAll } from '@/lib/forms/queries-modules/_shared';
import type { SdUser } from '@/lib/forms/types';
import { BuyingPlanRuleEditor } from './buying-plan-rule-editor';
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

  const db=await client();
  const [rules,approvalRule,users] = await Promise.all([
    loadAnalyticsRuleRows(), loadBuyingPlanApprovalRule(db),
    pageAll<SdUser>(()=>db.from('sd_user').select('email,full_name,role,is_active').order('email')),
  ]);

  return (
    <FormLayout
      title="Rules Master"
      subtitle="Every judgement threshold the dashboard cards read — edited here, not hardcoded. A change takes effect on the next page load, no redeploy."
      active="/rules-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <BuyingPlanRuleEditor rule={approvalRule} users={users} />
      <RulesMasterClient rules={rules} role={user.role} />
    </FormLayout>
  );
}
