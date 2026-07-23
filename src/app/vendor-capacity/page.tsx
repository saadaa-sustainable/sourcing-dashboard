import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { weekLabel } from '@/lib/forms/approval';
import {
  currentUser,
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

  const { week, logs, priorLogs, multipliers, rollups, vendorMasters, vendorTypes } =
    await loadVendorCapacity();

  const currentByCode = new Map(logs.map((row) => [key(row.vendor_code), row]));
  const priorByCode = new Map(priorLogs.map((row) => [key(row.vendor_code), row]));
  const inProcessByCode = new Map(
    rollups.map((row) => [key(row.vendorCode), row.openQty]),
  );
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
        vendor_type: typeByCode.get(code) ?? '',
        inProcessQty: inProcessByCode.get(code) ?? 0,
        current: currentByCode.get(code) ?? null,
        prior: priorByCode.get(code) ?? null,
      };
    })
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

  return (
    <FormLayout
      title="Vendor Capacity"
      subtitle={`Weekly capacity input — ${weekLabel(week)}. No approval; input and update only.`}
      active="/vendor-capacity"
      role={user.role}
    >
      <VendorCapacityClient
        week={week}
        vendors={vendors}
        multipliers={multipliers}
        role={user.role}
      />
    </FormLayout>
  );
}
