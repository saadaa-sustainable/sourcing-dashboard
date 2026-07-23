import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { monthLabel, monthStart } from '@/lib/forms/approval';
import {
  currentUser,
  loadActualsByProduct,
  loadBuyingPlan,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { BuyingPlanClient } from './buying-plan-client';

export const dynamic = 'force-dynamic';

export default async function BuyingPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const params = await searchParams;
  const planMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '')
    ? params.month!
    : monthStart();

  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Buying Plan" active="/buying-plan" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (!user.email.endsWith('@saadaa.in')) {
    redirect('/login?error=This+dashboard+is+restricted+to+SAADAA+accounts.');
  }

  const [{ plan, lines, productCodes }, actualsMap] = await Promise.all([
    loadBuyingPlan(planMonth),
    loadActualsByProduct(planMonth),
  ]);

  return (
    <FormLayout
      title="Buying Plan"
      subtitle={`Monthly buying budget — ${monthLabel(planMonth)}. Submitted for approval before POs are issued.`}
      active="/buying-plan"
      role={user.role}
    >
      <BuyingPlanClient
        planMonth={planMonth}
        plan={plan}
        lines={lines}
        productCodes={productCodes}
        actuals={Object.fromEntries(actualsMap)}
        role={user.role}
      />
    </FormLayout>
  );
}
