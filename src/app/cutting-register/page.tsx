import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadCuttingRegisters,
  loadDynamicLinks,
  loadProductBom,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import { CuttingRegisterClient } from './cutting-register-client';

export const dynamic = 'force-dynamic';

export default async function CuttingRegisterPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Cutting Register" active="/cutting-register" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }
  if (!user) redirect('/login');

  const [entries, links, bom] = await Promise.all([
    loadCuttingRegisters(),
    loadDynamicLinks(),
    loadProductBom(),
  ]);

  return (
    <FormLayout
      title="Cutting Register"
      subtitle="Actual fabric consumption per PO vs the BOM standard. Generate a no-login link for vendors / field staff to submit."
      active="/cutting-register"
      role={user.role}
      userEmail={user.email}
      accent="orange"
    >
      <CuttingRegisterClient
        entries={entries}
        links={links}
        bom={bom}
        editable={canEdit(user.role, 'draft')}
      />
    </FormLayout>
  );
}
