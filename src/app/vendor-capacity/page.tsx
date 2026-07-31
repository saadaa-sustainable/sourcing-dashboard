import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadInProcessByVendor,
  loadVendorCapacity,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { VendorCapacityClient } from './vendor-capacity-client';

export const dynamic = 'force-dynamic';

const key = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

export default async function VendorCapacityPage() {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout title="Vendor Capacity" active="/vendor-capacity" role="viewer">
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }
    throw error;
  }

  if (!user) redirect('/login');

  const { logs, multipliers, vendorMasters, vendorTypes } =
    await loadVendorCapacity();
  // Real in-process load from the PO pipeline (sd_vendor_in_process), not the sheet.
  const inProcessByCode = await loadInProcessByVendor();

  const currentByCode = new Map(logs.map((row) => [key(row.vendor_code), row]));
  // Fallback type source if a master row has no primary_type set.
  const typeByCode = new Map(
    vendorTypes.map((row) => [key(row.vendor_code), row.vendor_type ?? '']),
  );

  const vendors = vendorMasters
    .filter((master) => key(master.vendor_code))
    .map((master) => {
      const code = key(master.vendor_code);
      return {
        vendor_code: master.vendor_code,
        vendor_name: master.vendor_name ?? master.vendor_code,
        // Vendor type is frozen at onboarding — from the master, not editable.
        vendor_type: master.primary_type || typeByCode.get(code) || '',
        // Onboarding constants, ingested (not weekly inputs).
        machinesAtOnboarding: master.machines_for_saadaa ?? 0,
        capacitySigned: master.capacity_per_month ?? 0,
        inProcessQty: inProcessByCode.get(code) ?? 0,
        current: currentByCode.get(code) ?? null,
      };
    })
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

  return (
    <FormLayout
      title="Vendor Capacity"
      subtitle="Per-vendor capacity — update one vendor at a time; each save is stamped so stale vendors stand out. No approval; input and update only."
      active="/vendor-capacity"
      role={user.role}
      userEmail={user.email}
    >
      <VendorCapacityClient
        vendors={vendors}
        multipliers={multipliers}
        role={user.role}
      />
    </FormLayout>
  );
}
