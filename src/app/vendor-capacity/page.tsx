import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadInProcessByVendor,
  loadProductCatalog,
  loadVendorCapacity,
  loadVendorCapacityAsOfWeek,
  loadVendorCapacityBoard,
  loadVendorProductAllocations,
  loadDeboardedVendors,
  NotConfiguredError,
} from '@/lib/forms/queries';
import { capacityRulesFrom, eeVendorActive } from '@/lib/business-logic';
import { capacityWeekStart } from '@/lib/forms/approval';
import { VendorCapacityClient } from './vendor-capacity-client';
import { MonthBoard } from '@/components/month-board';

export const dynamic = 'force-dynamic';

const key = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

export default async function VendorCapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; week?: string }>;
}) {
  const params = await searchParams;
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

  const { logs, vendorMasters, vendorTypes, multipliers } = await loadVendorCapacity();
  // Real in-process load from the PO pipeline (sd_vendor_in_process), not the sheet.
  const inProcessByCode = await loadInProcessByVendor();
  // Item 1 product allocations + catalog, and item 3 day-count rules — for the sub-tabs.
  const [allocations, catalog, rules, deboarded] = await Promise.all([
    loadVendorProductAllocations(),
    loadProductCatalog(),
    loadAnalyticsRules(),
    loadDeboardedVendors(),
  ]);

  const currentByCode = new Map(logs.map((row) => [key(row.vendor_code), row]));
  // Fallback type source if a master row has no primary_type set.
  const typeByCode = new Map(
    vendorTypes.map((row) => [key(row.vendor_code), row.vendor_type ?? '']),
  );

  // "Active" comes from EasyEcom's vendor status (vendor_master_data.ee_status,
  // pulled through GCP) — the authoritative source. Until the first GCP vendor
  // sync populates it (ee_status null), fall back to the Vendor_Type_Master
  // status, matched by code first then name (the dashboard's "Active vendors"
  // signal), so the page is never empty during the transition.
  const statusByCode = new Map(vendorTypes.map((row) => [key(row.vendor_code), row.status]));
  const statusByName = new Map(vendorTypes.map((row) => [key(row.vendor_name), row.status]));
  const isActive = (master: (typeof vendorMasters)[number]) => {
    const ee = eeVendorActive(master.ee_status);
    if (ee !== null) return ee;
    const status = statusByCode.get(key(master.vendor_code)) ?? statusByName.get(key(master.vendor_name));
    return key(status) === 'active';
  };

  const vendors = vendorMasters
    .filter((master) => key(master.vendor_code) && isActive(master))
    .map((master) => {
      const code = key(master.vendor_code);
      return {
        vendor_code: master.vendor_code,
        vendor_name: master.vendor_name ?? master.vendor_code,
        // Vendor type is frozen at onboarding — from the master, not editable.
        vendor_type: master.primary_type || typeByCode.get(code) || '',
        // Merchandiser who manages this vendor (for the item-2 filter).
        merchant: master.merchant_name ?? '',
        // Onboarding constants, ingested (not weekly inputs).
        machinesAtOnboarding: master.machines_for_saadaa ?? 0,
        capacitySigned: master.capacity_per_month ?? 0,
        inProcessQty: inProcessByCode.get(code) ?? 0,
        current: currentByCode.get(code) ?? null,
        // Approved de-boarding: still listed (open POs still need capacity), but marked.
        deboarded: deboarded[code.toUpperCase()] ?? null,
      };
    })
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

  // Landing view: one card per Monday-to-Sunday week showing how many active vendors updated capacity in it.
  if (!params.view) {
    const board = await loadVendorCapacityBoard(
      vendors.map((v) => ({ code: v.vendor_code, name: v.vendor_name, signed: Number(v.capacitySigned) || 0 })),
    );
    return (
      <FormLayout
        title="Vendor Capacity"
        subtitle="Week by week (Monday to Sunday): how many active vendors updated their capacity, and the capacity they declared. Open a week to update vendors."
        active="/vendor-capacity"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <MonthBoard data={board} searchPlaceholder="Search week…" />
      </FormLayout>
    );
  }

  // A past week (?week=<its Monday>, from a board card): each vendor's figures as they stood at
  // the end of that week, read-only. The current week (or no week) is the live, editable sheet.
  const week =
    params.week && /^\d{4}-\d{2}-\d{2}$/.test(params.week) && params.week === capacityWeekStart(new Date(`${params.week}T12:00:00+05:30`))
      ? params.week
      : null;
  let asOf: { week: string; label: string } | null = null;
  let shown = vendors;
  if (week && week < capacityWeekStart()) {
    const snap = await loadVendorCapacityAsOfWeek(week);
    shown = vendors.map((v) => {
      const e = snap.get(key(v.vendor_code));
      return {
        ...v,
        current: e
          ? { ...(v.current ?? {}), vendor_code: v.vendor_code, machines_allocated: e.machines, active_karigar: e.karigar, capacity_per_month: e.capacity, entry_date: e.at, submitted_at: e.at } as NonNullable<typeof v.current>
          : null,
      };
    });
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const end = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    asOf = { week, label: `Mon ${day(week)} – Sun ${day(end)}` };
  }

  return (
    <FormLayout
      title="Vendor Capacity"
      subtitle="Per-vendor capacity for active vendors — update one vendor at a time; each save is stamped so stale vendors stand out. No approval; input and update only."
      active="/vendor-capacity"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <Link className="mb-back" href="/vendor-capacity">← All weeks</Link>
      <VendorCapacityClient
        vendors={shown}
        asOf={asOf}
        role={user.role}
        allocations={allocations}
        catalog={catalog}
        multipliers={multipliers}
        leadDays={{
          job: rules.lead_days_job,
          efob: rules.lead_days_efob,
          fob: rules.lead_days_fob,
        }}
        rules={capacityRulesFrom(rules)}
      />
    </FormLayout>
  );
}
