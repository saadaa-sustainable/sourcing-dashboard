import Link from 'next/link';
import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import {
  currentUser,
  loadAnalyticsRules,
  loadInProcessByVendor,
  loadInProcessForWeek,
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
  let asOf: { week: string; label: string; inProcessKept: boolean } | null = null;
  let shown = vendors;
  if (week && week < capacityWeekStart()) {
    const [snap, inProcessThen] = await Promise.all([loadVendorCapacityAsOfWeek(week), loadInProcessForWeek(week)]);
    shown = vendors.map((v) => {
      const e = snap.get(key(v.vendor_code));
      return {
        ...v,
        // On order at the end of that week, once the weekly copy covers it; else today's.
        inProcessQty: inProcessThen ? (inProcessThen.get(key(v.vendor_code)) ?? 0) : v.inProcessQty,
        current: e
          ? { ...(v.current ?? {}), vendor_code: v.vendor_code, machines_allocated: e.machines, active_karigar: e.karigar, capacity_per_month: e.capacity, entry_date: e.at, submitted_at: e.at } as NonNullable<typeof v.current>
          : null,
      };
    });
    const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
    const end = new Date(Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    asOf = { week, label: `Mon ${day(week)} – Sun ${day(end)}`, inProcessKept: inProcessThen != null };
  }

  // Week bar: the week shown, with ‹ › to the weeks either side (back to the first week any
  // vendor has an update in; forward up to the running week, which is the editable sheet).
  const curWeek = capacityWeekStart();
  const shownWeek = asOf?.week ?? curWeek;
  const shift = (w: string, days: number) => new Date(Date.parse(`${w}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  const weekHref = (w: string) => (w >= curWeek ? '/vendor-capacity?view=vendors' : `/vendor-capacity?view=vendors&week=${w}`);
  const firstUpdate = vendors.map((v) => v.current?.entry_date).filter((d): d is string => !!d).sort()[0];
  const firstWeek = firstUpdate ? capacityWeekStart(new Date(firstUpdate)) : curWeek;
  const prevWeek = shownWeek > firstWeek ? shift(shownWeek, -7) : null;
  const nextWeek = shownWeek < curWeek ? shift(shownWeek, 7) : null;
  const shortDay = (iso: string, year = false) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
  const weekText = `${shortDay(shownWeek)} – ${shortDay(shift(shownWeek, 6), true)}`;
  const thu = Date.parse(`${shift(shownWeek, 3)}T00:00:00Z`);
  const weekNo = Math.floor((thu - Date.UTC(new Date(thu).getUTCFullYear(), 0, 1)) / 86_400_000 / 7) + 1;

  return (
    <FormLayout
      title="Vendor Capacity"
      subtitle={
        asOf
          ? `What each active vendor had entered by the end of the week ${asOf.label}. View only.`
          : 'Update machines and karigars for each active vendor, any day of the week. No approval; every save is stamped so stale vendors stand out.'
      }
      active="/vendor-capacity"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <div className="vc2-weekbar">
        <div className="vc2-weekbar-left">
          <Link className="vc2-back" href="/vendor-capacity" aria-label="All weeks" title="All weeks">‹</Link>
          <div>
            <div className="vc2-weekbar-title">
              <strong>Week of {weekText}</strong>
              {asOf ? <span className="vc2-badge">View only</span> : <span className="vc2-badge ok"><i />This week</span>}
            </div>
            <Link className="vc2-weekbar-sub" href="/vendor-capacity">All weeks</Link>
          </div>
        </div>
        <div className="vc2-weekbar-right">
          <nav className="vc2-stepper" aria-label="Week">
            {prevWeek ? <Link href={weekHref(prevWeek)} aria-label="Previous week" title="Previous week">‹</Link> : <span aria-hidden="true">‹</span>}
            <span className="vc2-stepper-label">Week {weekNo}</span>
            {nextWeek ? <Link href={weekHref(nextWeek)} aria-label="Next week" title="Next week">›</Link> : <span aria-hidden="true">›</span>}
          </nav>
          {asOf && <Link className="vc2-btn vc2-btn-primary" href="/vendor-capacity?view=vendors">Open this week</Link>}
        </div>
      </div>
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
