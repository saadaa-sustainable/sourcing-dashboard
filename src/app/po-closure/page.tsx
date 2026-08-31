import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCuttingRegisters,
  loadPoClosures,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { PoClosureClient } from './po-closure-client';

export const dynamic = 'force-dynamic';

export default async function PoClosurePage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="PO Closure" active="/po-closure" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const [closures, cutting] = await Promise.all([loadPoClosures(), loadCuttingRegisters()]);

  return (
    <FormLayout
      title="PO Closure"
      subtitle="Gated, two-leg (sourcing → finance) closure with a 15-day SLA. Green within SLA, red once breached — real-time, including still-open POs."
      active="/po-closure"
      role={user.role}
      userEmail={user.email}
      accent="teal"
    >
      <PoClosureClient closures={closures} cutting={cutting} editable={canEdit(user.role, 'draft')} />
    </FormLayout>
  );
}
