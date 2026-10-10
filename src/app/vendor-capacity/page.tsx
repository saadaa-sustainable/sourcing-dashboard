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
import { capacityRulesFrom, eeVendorActive, vendorCapacityModel } from '@/lib/business-logic';
import { vendorCapacityVariation } from '@/lib/forms/queries-modules/variation-reports';
import { VariationReportPanel } from '@/components/variation-report';
import { capacityWeekStart, monthStart } from '@/lib/forms/approval';
import Link from 'next/link';
import { loadVendorCapacityMonth, loadVendorCapacityReportStatus } from '@/lib/vendor-capacity-month';
import { VendorCapacityMonthView } from './vendor-capacity-month-view';
import { VendorCapacityClient } from './vendor-capacity-client';
import { MonthBoard } from '@/components/month-board';
import { WeekHeader, type HeaderWeek } from './week-header';

export const dynamic = 'force-dynamic';

const key = (value: string | null | undefined) => (value ?? '').trim().toLowerCase();

export default async function VendorCapacityPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; week?: string; month?: string }>;
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
        <MonthBoard
          data={board}
          searchPlaceholder="Search week…"
          pageBar={<Link className="wf-btn wf-btn-primary wf-btn-sm" href={`/vendor-capacity?view=month&month=${monthStart()}`}>Monthly analysis</Link>}
        />
      </FormLayout>
    );
  }

  // Monthly analysis (?view=month&month=YYYY-MM-01): the weekly input rolled up for a month, and
  // the month's mandatory report to management.
  if (params.view === 'month') {
    const month = /^\d{4}-\d{2}-01$/.test(params.month ?? '') && (params.month as string) <= monthStart() ? (params.month as string) : monthStart();
    const board = await loadVendorCapacityBoard(
      vendors.map((v) => ({ code: v.vendor_code, name: v.vendor_name, signed: Number(v.capacitySigned) || 0 })),
    );
    const months = Array.from(new Set([...board.cards.map((c) => `${c.month.slice(0, 7)}-01`), monthStart(), month])).sort();
    const [data, report] = await Promise.all([loadVendorCapacityMonth(month), loadVendorCapacityReportStatus(month)]);
    return (
      <FormLayout title="Vendor Capacity" active="/vendor-capacity" role={user.role} userEmail={user.email} allowedPages={user.allowed_pages ?? null}>
        <VendorCapacityMonthView data={data} report={report} months={months} isAdmin={user.role === 'admin'} />
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
  let variation: ReturnType<typeof vendorCapacityVariation> | null = null;
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
    // A closed week opens with its Variation Report: PO capacity vs quantity on order.
    const capRules = capacityRulesFrom(rules);
    variation = vendorCapacityVariation(
      asOf,
      shown.map((v) => {
        const m = vendorCapacityModel(
          { machines: v.current?.machines_allocated ?? null, karigar: v.current?.active_karigar ?? null, vendorType: v.vendor_type, inProcessQty: v.inProcessQty },
          capRules,
        );
        return { code: v.vendor_code, name: v.vendor_name, type: v.vendor_type || null, poCapacity: m.entered ? m.poCapacity : null, onOrder: Number(v.inProcessQty) || 0 };
      }),
    );
  }

  // Week header: statuses and the list of weeks come from the board itself, so the header and
  // the board never disagree.
  const curWeek = capacityWeekStart();
  const board = await loadVendorCapacityBoard(
    vendors.map((v) => ({ code: v.vendor_code, name: v.vendor_name, signed: Number(v.capacitySigned) || 0 })),
  );
  const headerWeeks: HeaderWeek[] = board.cards.map((c) => {
    const [done, total] = (c.list[0] ?? '0 / 0').split('/').map((x) => Number(x.trim()) || 0);
    return { week: c.month, status: c.status, submitted: done, total };
  });

  return (
    <FormLayout
      title="Vendor Capacity"
      active="/vendor-capacity"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <WeekHeader weeks={headerWeeks} shown={asOf?.week ?? curWeek} current={curWeek} />
      {variation && <VariationReportPanel report={variation} />}
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
