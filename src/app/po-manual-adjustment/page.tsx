import { redirect } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadCached, refreshState } from '@/lib/adjustments';

export const dynamic = 'force-dynamic';

// Where adjustments are actually entered (external Google Apps Script portal).
const PORTAL_URL =
  'https://script.google.com/a/macros/saadaa.in/s/AKfycbyfPaRfi-Qh2MzjHaov2vT570Y4Inu7yUDFlXAE2gZ5w4wc-JEMhvzomnijngQQqBqB/exec';

export default async function PoManualAdjustmentPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Manual Data Ingestion" active="/po-manual-adjustment" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const [manualRows, cuttingRows, manualState, cuttingState] = await Promise.all([
    loadCached('po'),
    loadCached('cutting'),
    refreshState(user.email, 'po'),
    refreshState(user.email, 'cutting'),
  ]);

  const { PoManualAdjustmentClient } = await import('./po-manual-adjustment-client');

  return (
    <FormLayout
      title="Manual Data Ingestion"
      subtitle="All PO manual adjustments and cutting-register entries ingested via the portal. Refresh (2×/hour per table) reloads the newest synced data to confirm an entry has landed."
      active="/po-manual-adjustment"
      role={user.role}
      userEmail={user.email}
      accent="orange"
      actions={
        <a className="wf-btn wf-btn-primary" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} /> Open ingestion portal
        </a>
      }
    >
      <PoManualAdjustmentClient
        portalUrl={PORTAL_URL}
        manualRows={manualRows}
        cuttingRows={cuttingRows}
        manualState={manualState}
        cuttingState={cuttingState}
      />
    </FormLayout>
  );
}
