import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, loadIssuedPos, loadPoAmendments, NotConfiguredError } from '@/lib/forms/queries';
import { PoAmendmentClient } from './po-amendment-client';

export const dynamic = 'force-dynamic';

/**
 * Spec 7.9 — amend a PO that is already issued in EasyEcom: cost, quantity or time, with
 * the reason, through the same approval flow as the PO itself. A separate page from PO
 * Approval on purpose: that page raises new POs; this one changes issued ones.
 */
export default async function PoAmendmentPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Amendment" active="/po-amendment" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const [issued, amendments] = await Promise.all([loadIssuedPos(), loadPoAmendments()]);

  return (
    <FormLayout
      title="PO Amendment"
      subtitle="Change the cost, quantity or delivery date of a PO already issued in EasyEcom — with the reason, through approval, so Finance can accept it."
      active="/po-amendment"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <PoAmendmentClient issued={issued} amendments={amendments} role={user.role} />
    </FormLayout>
  );
}
