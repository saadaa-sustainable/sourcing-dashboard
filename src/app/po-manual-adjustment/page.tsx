import { redirect } from 'next/navigation';
import { ExternalLink } from 'lucide-react';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { currentUser, NotConfiguredError } from '@/lib/forms/queries';

export const dynamic = 'force-dynamic';

// The PO Manual Adjustment data-entry portal is a Google Apps Script web app
// (hosted on script.google.com), not a page in this app. We embed it, but Apps
// Script often refuses cross-origin framing (X-Frame-Options), so there is always
// an explicit "open in a new tab" link as the reliable path.
const PORTAL_URL =
  'https://script.google.com/a/macros/saadaa.in/s/AKfycbyfPaRfi-Qh2MzjHaov2vT570Y4Inu7yUDFlXAE2gZ5w4wc-JEMhvzomnijngQQqBqB/exec';

export default async function PoManualAdjustmentPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Manual Adjustment" active="/po-manual-adjustment" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  return (
    <FormLayout
      title="PO Manual Adjustment"
      subtitle="Data ingestion portal for manual PO corrections. Opens the SAADAA Apps Script portal below."
      active="/po-manual-adjustment"
      role={user.role}
      userEmail={user.email}
      accent="orange"
      actions={
        <a className="help-button" href={PORTAL_URL} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={16} /> Open portal in a new tab
        </a>
      }
    >
      <Notice tone="info">
        The portal loads below. If it stays blank (Google may block embedding), use{' '}
        <a href={PORTAL_URL} target="_blank" rel="noopener noreferrer">
          open portal in a new tab
        </a>
        .
      </Notice>
      <iframe
        title="PO Manual Adjustment portal"
        src={PORTAL_URL}
        style={{
          width: '100%',
          height: '75vh',
          border: '1px solid var(--border, #e2e8f0)',
          borderRadius: 8,
          marginTop: 12,
          background: '#fff',
        }}
      />
    </FormLayout>
  );
}
