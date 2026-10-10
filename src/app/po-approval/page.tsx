import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadDeboardedVendors,
  loadDeletedPoRequests,
  loadPoApprovals,
  loadPoDeleteRequests,
  loadPoReviewItems,
  loadPoSubmissions,
  loadStandardCmByCode,
  loadTnaLeadtimes,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canView } from '@/lib/views';
import { PoApprovalClient } from './po-approval-client';

export const dynamic = 'force-dynamic';

export default async function PoApprovalPage({ searchParams }: { searchParams: Promise<{ edit?: string }> }) {
  const params = await searchParams;
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
  // Access is grantable via custom roles (e.g. the Sourcing role). Team users raise / submit /
  // issue POs here; the approver decides on the card (the same bar as the Approvals queue).
  if (!canView('/po-approval', user.role, user.allowed_pages ?? null)) redirect('/');

  const [
    { pos, cycleById, linesByPo, productCodes, vendorCodes, vendorNames, vendorTypes, productNames, capacityByVendor },
    submissions,
    leadtimes,
    stdCm,
    deboarded,
  ] = await Promise.all([
    loadPoApprovals(),
    loadPoSubmissions(),
    loadTnaLeadtimes(),
    loadStandardCmByCode(),
    loadDeboardedVendors(),
  ]);
  const deleteRequests = await loadPoDeleteRequests();
  // The review (stock, cost, TNA, vendor) for every PO still in the queue — the same item
  // the Approvals page renders, so the two pages never disagree.
  const reviewItems = await loadPoReviewItems(pos.filter((p) => p.status === 'submitted' || p.status === 'pending_l2'));
  const reviewById = Object.fromEntries(reviewItems.map((i) => [i.entityId, i]));

  // The deleted-requests log is an admin view — the team sees its own deletions as
  // they happen (the request simply leaves their list), admin sees the whole record.
  const deletedRequests = user.role === 'admin' ? await loadDeletedPoRequests() : [];

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
        vendorTypes={vendorTypes}
        productNames={productNames}
        deboarded={deboarded}
        submissions={submissions}
        leadtimes={leadtimes}
        stdCm={stdCm}
        role={user.role}
        userEmail={user.email}
        deletedRequests={deletedRequests}
        deleteRequests={deleteRequests}
        reviewById={reviewById}
        initialEditId={params.edit ? Number(params.edit) : null}
      />
    </FormLayout>
  );
}
