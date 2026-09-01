import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadMaterialMaster,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import type { MaterialType } from '@/lib/forms/types';
import { MaterialMasterClient } from './material-master-client';

export const dynamic = 'force-dynamic';

export default async function MaterialMasterPage({
  searchParams,
}: {
  searchParams: Promise<{ type?: string }>;
}) {
  const { type } = await searchParams;
  // Raw fabrics moved to Fabric Master; this tab manages Dyed + Trim only.
  const initialType: MaterialType = type === 'trim' ? 'trim' : 'dyed';
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Material Master" active="/material-master" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const { materials, colours, fabricCodes } = await loadMaterialMaster();

  return (
    <FormLayout
      title="Material Master"
      subtitle="One code list for Raw, Dyed and Trim materials — the source the Buying Plan material track picks from."
      active="/material-master"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <MaterialMasterClient
        materials={materials}
        colours={colours}
        fabricCodes={fabricCodes}
        initialType={initialType}
        editable={canEdit(user.role, 'draft')}
      />
    </FormLayout>
  );
}
