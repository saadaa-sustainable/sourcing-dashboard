import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadPoApprovals,
  loadPoSubmissions,
  loadStandardCmByCode,
  loadTnaLeadtimes,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { PoApprovalClient } from './po-approval-client';

export const dynamic = 'force-dynamic';

export default async function PoApprovalPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Approval" active="/po-approval" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');
  if (user.role !== 'admin') redirect('/');

  const [
    { pos, cycleById, linesByPo, productCodes, vendorCodes, vendorNames, capacityByVendor },
    submissions,
    leadtimes,
    stdCm,
  ] = await Promise.all([
    loadPoApprovals(),
    loadPoSubmissions(),
    loadTnaLeadtimes(),
    loadStandardCmByCode(),
  ]);

  return (
    <FormLayout
      title="PO Approval"
      subtitle="Raise a purchase order for approval, route by value, then issue against a real EasyCom PO."
      active="/po-approval"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <PoApprovalClient
        pos={pos}
        cycle={Object.fromEntries(cycleById)}
        linesByPo={Object.fromEntries(linesByPo)}
        capacity={Object.fromEntries(capacityByVendor)}
        productCodes={productCodes}
        vendorCodes={vendorCodes}
        vendorNames={vendorNames}
        submissions={submissions}
        leadtimes={leadtimes}
        stdCm={stdCm}
        role={user.role}
      />
    </FormLayout>
  );
}
