import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadCashFlow, NotConfiguredError } from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { CashFlowClient } from './cash-flow-client';

export const dynamic = 'force-dynamic';

export default async function CashFlowPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Cash Flow" active="/cash-flow" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const { months, vendorTerms } = await loadCashFlow();

  return (
    <FormLayout
      title="Cash Flow Forecast"
      subtitle="Payment obligations to vendors by month — buying commitments projected forward through payment terms."
      active="/cash-flow"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <CashFlowClient
        months={months}
        vendorTerms={vendorTerms}
        editable={canEdit(user.role, 'draft')}
      />
    </FormLayout>
  );
}
