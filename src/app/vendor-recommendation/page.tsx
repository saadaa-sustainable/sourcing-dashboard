import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadVendorRecommendation,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { VendorRecommendationClient } from './vendor-recommendation-client';

export const dynamic = 'force-dynamic';

export default async function VendorRecommendationPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor Recommendation" active="/vendor-recommendation" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const rows = await loadVendorRecommendation();

  return (
    <FormLayout
      title="Vendor Recommendation"
      subtitle="Vendors ranked by completed-PO reliability since 2025 — completion, on-time (GRN receipt vs EDD) and delay."
      active="/vendor-recommendation"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
      accent="blue"
    >
      <VendorRecommendationClient rows={rows} />
    </FormLayout>
  );
}
