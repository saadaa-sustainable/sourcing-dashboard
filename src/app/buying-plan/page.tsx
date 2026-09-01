import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { monthLabel, monthStart } from '@/lib/forms/approval';
import {
  currentUser,
  loadActualsByProduct,
  loadBuyingPlan,
  loadMaterialPlan,
  loadProductCatalog,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { BuyingPlanClient } from './buying-plan-client';
import { MaterialPlanClient } from './material-plan-client';
import { PlanTypeTabs } from './plan-type-tabs';

export const dynamic = 'force-dynamic';

export default async function BuyingPlanPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; type?: string }>;
}) {
  const params = await searchParams;
  const planMonth = /^\d{4}-\d{2}-01$/.test(params.month ?? '')
    ? params.month!
    : monthStart();
  const planType = params.type === 'material' ? 'material' : 'fg';

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

  const subtitle = `Monthly buying budget — ${monthLabel(planMonth)}. ${
    planType === 'material' ? 'Fabric / material track.' : 'Finished-goods track.'
  } Submitted for approval before POs are issued.`;

  return (
    <FormLayout
      title="Buying Plan"
      subtitle={subtitle}
      active="/buying-plan"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <PlanTypeTabs planMonth={planMonth} planType={planType} />
      {planType === 'material' ? (
        <MaterialTrack planMonth={planMonth} role={user.role} />
      ) : (
        <FgTrack planMonth={planMonth} role={user.role} />
      )}
    </FormLayout>
  );
}

async function FgTrack({ planMonth, role }: { planMonth: string; role: 'viewer' | 'team' | 'admin' }) {
  const [
    { plan, lines, productCodes, productMaster, standardCosts, pendingByCode },
    actualsMap,
    catalog,
  ] = await Promise.all([
    loadBuyingPlan(planMonth),
    loadActualsByProduct(planMonth),
    loadProductCatalog(),
  ]);
  return (
    <BuyingPlanClient
      planMonth={planMonth}
      plan={plan}
      lines={lines}
      productCodes={productCodes}
      productMaster={productMaster}
      standardCosts={standardCosts}
      pendingByCode={pendingByCode}
      actuals={Object.fromEntries(actualsMap)}
      catalog={catalog}
      role={role}
    />
  );
}

async function MaterialTrack({ planMonth, role }: { planMonth: string; role: 'viewer' | 'team' | 'admin' }) {
  const { plan, lines, materialCodes, colours, materialCosts } = await loadMaterialPlan(planMonth);
  return (
    <MaterialPlanClient
      planMonth={planMonth}
      plan={plan}
      lines={lines}
      materialCodes={materialCodes}
      colours={colours}
      materialCosts={materialCosts}
      role={role}
    />
  );
}
