import { redirect } from 'next/navigation';
import Link from 'next/link';

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
  loadVendorCapacityMonthBoard,
  loadVendorProductAllocations,
  loadDeboardedVendors,
  NotConfiguredError,
} from '@/lib/forms/queries';

import {
  capacityRulesFrom,
  eeVendorActive,
  vendorCapacityModel,
} from '@/lib/business-logic';

import { vendorCapacityVariation } from '@/lib/forms/queries-modules/variation-reports';
import { VariationReportPanel } from '@/components/variation-report';
import { capacityWeekStart, monthStart } from '@/lib/forms/approval';

import {
  loadVendorCapacityMonth,
  loadVendorCapacityReportStatus,
} from '@/lib/vendor-capacity-month';

import { VendorCapacityMonthView } from './vendor-capacity-month-view';
import { VendorCapacityClient } from './vendor-capacity-client';
import { MonthBoard } from '@/components/month-board';
import { WeekHeader, type HeaderWeek } from './week-header';

export const dynamic = 'force-dynamic';

const key = (value: string | null | undefined) =>
  (value ?? '').trim().toLowerCase();

export default async function VendorCapacityPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    week?: string;
    month?: string;
  }>;
}) {
  const params = await searchParams;

  let user;

  try {
    user = await currentUser();
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return (
        <FormLayout
          title="Vendor Capacity"
          active="/vendor-capacity"
          role="viewer"
        >
          <Notice tone="error">{error.message}</Notice>
        </FormLayout>
      );
    }

    throw error;
  }

  if (!user) redirect('/login');

  const { logs, vendorMasters, vendorTypes, multipliers } =
    await loadVendorCapacity();

  // Real in-process load from the PO pipeline.
  const inProcessByCode = await loadInProcessByVendor();

  const [allocations, catalog, rules, deboarded] = await Promise.all([
    loadVendorProductAllocations(),
    loadProductCatalog(),
    loadAnalyticsRules(),
    loadDeboardedVendors(),
  ]);

  const currentByCode = new Map(
    logs.map((row) => [key(row.vendor_code), row]),
  );

  const typeByCode = new Map(
    vendorTypes.map((row) => [
      key(row.vendor_code),
      row.vendor_type ?? '',
    ]),
  );

  // EasyEcom is the authoritative source for active vendor status.
  // Fall back to Vendor_Type_Master while EasyEcom status is unavailable.
  const statusByCode = new Map(
    vendorTypes.map((row) => [key(row.vendor_code), row.status]),
  );

  const statusByName = new Map(
    vendorTypes.map((row) => [key(row.vendor_name), row.status]),
  );

  const isActive = (master: (typeof vendorMasters)[number]) => {
    const ee = eeVendorActive(master.ee_status);

    if (ee !== null) return ee;

    const status =
      statusByCode.get(key(master.vendor_code)) ??
      statusByName.get(key(master.vendor_name));

    return key(status) === 'active';
  };

  const vendors = vendorMasters
    .filter((master) => key(master.vendor_code) && isActive(master))
    .map((master) => {
      const code = key(master.vendor_code);

      return {
        vendor_code: master.vendor_code,
        vendor_name: master.vendor_name ?? master.vendor_code,

        // Vendor type is frozen at onboarding.
        vendor_type:
          master.primary_type || typeByCode.get(code) || '',

        merchant: master.merchant_name ?? '',

        machinesAtOnboarding: master.machines_for_saadaa ?? 0,
        capacitySigned: master.capacity_per_month ?? 0,

        inProcessQty: inProcessByCode.get(code) ?? 0,
        current: currentByCode.get(code) ?? null,

        // Keep approved de-boarded vendors visible for open POs.
        deboarded: deboarded[code.toUpperCase()] ?? null,
      };
    })
    .sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));

  // ============================================================
  // LANDING PAGE: MONTHLY CAPACITY CARDS
  // ============================================================
  // Each update is shown under the calendar month in which it
  // happened. The weekly history logic remains separate below.
  if (!params.view) {
    const board = await loadVendorCapacityMonthBoard(
      vendors.map((v) => ({
        code: v.vendor_code,
        name: v.vendor_name,
        signed: Number(v.capacitySigned) || 0,
      })),
    );

    return (
      <FormLayout
        title="Vendor Capacity"
        subtitle="Month by month: review vendor capacity updates recorded in each calendar month. Open a month to view its updates."
        active="/vendor-capacity"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <MonthBoard
          data={board}
          searchPlaceholder="Search month…"
          pageBar={
            <Link
              className="wf-btn wf-btn-primary wf-btn-sm"
              href={`/vendor-capacity?view=month&month=${monthStart()}`}
            >
              Monthly Analytics
            </Link>
          }
        />
      </FormLayout>
    );
  }

  // ============================================================
  // MONTHLY ANALYSIS
  // ?view=month&month=YYYY-MM-01
  // ============================================================
  if (params.view === 'month') {
    const month =
      /^\d{4}-\d{2}-01$/.test(params.month ?? '') &&
      (params.month as string) <= monthStart()
        ? (params.month as string)
        : monthStart();

    // Keep the existing weekly board for deriving available months.
    const board = await loadVendorCapacityBoard(
      vendors.map((v) => ({
        code: v.vendor_code,
        name: v.vendor_name,
        signed: Number(v.capacitySigned) || 0,
      })),
    );

    const months = Array.from(
      new Set([
        ...board.cards.map((c) => `${c.month.slice(0, 7)}-01`),
        monthStart(),
        month,
      ]),
    ).sort();

    const [data, report] = await Promise.all([
      loadVendorCapacityMonth(month),
      loadVendorCapacityReportStatus(month),
    ]);

    return (
      <FormLayout
        title="Vendor Capacity"
        active="/vendor-capacity"
        role={user.role}
        userEmail={user.email}
        allowedPages={user.allowed_pages ?? null}
      >
        <VendorCapacityMonthView
          data={data}
          report={report}
          months={months}
          isAdmin={user.role === 'admin'}
        />
      </FormLayout>
    );
  }

  // ============================================================
  // WEEKLY HISTORY / LIVE CAPACITY ENTRY
  // Keep this section weekly.
  // ============================================================
  const week =
    params.week &&
    /^\d{4}-\d{2}-\d{2}$/.test(params.week) &&
    params.week ===
      capacityWeekStart(
        new Date(`${params.week}T12:00:00+05:30`),
      )
      ? params.week
      : null;

  let asOf: {
    week: string;
    label: string;
    inProcessKept: boolean;
  } | null = null;

  let shown = vendors;

  let variation:
    | ReturnType<typeof vendorCapacityVariation>
    | null = null;

  if (week && week < capacityWeekStart()) {
    const [snap, inProcessThen] = await Promise.all([
      loadVendorCapacityAsOfWeek(week),
      loadInProcessForWeek(week),
    ]);

    shown = vendors.map((v) => {
      const e = snap.get(key(v.vendor_code));

      return {
        ...v,

        // Use the historical in-process quantity when available.
        inProcessQty: inProcessThen
          ? (inProcessThen.get(key(v.vendor_code)) ?? 0)
          : v.inProcessQty,

        current: e
          ? ({
              ...(v.current ?? {}),
              vendor_code: v.vendor_code,
              machines_allocated: e.machines,
              active_karigar: e.karigar,
              capacity_per_month: e.capacity,
              entry_date: e.at,
              submitted_at: e.at,
            } as NonNullable<typeof v.current>)
          : null,
      };
    });

    const day = (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });

    const end = new Date(
      Date.parse(`${week}T00:00:00Z`) + 6 * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);

    asOf = {
      week,
      label: `Mon ${day(week)} – Sun ${day(end)}`,
      inProcessKept: inProcessThen != null,
    };

    // Closed-week variation report: PO capacity vs quantity on order.
    const capRules = capacityRulesFrom(rules);

    variation = vendorCapacityVariation(
      asOf,
      shown.map((v) => {
        const m = vendorCapacityModel(
          {
            machines: v.current?.machines_allocated ?? null,
            karigar: v.current?.active_karigar ?? null,
            vendorType: v.vendor_type,
            inProcessQty: v.inProcessQty,
          },
          capRules,
        );

        return {
          code: v.vendor_code,
          name: v.vendor_name,
          type: v.vendor_type || null,
          poCapacity: m.entered ? m.poCapacity : null,
          onOrder: Number(v.inProcessQty) || 0,
        };
      }),
    );
  }

  // IMPORTANT:
  // This remains the weekly board used by WeekHeader.
  // Do not replace it with loadVendorCapacityMonthBoard().
  const curWeek = capacityWeekStart();

  const board = await loadVendorCapacityBoard(
    vendors.map((v) => ({
      code: v.vendor_code,
      name: v.vendor_name,
      signed: Number(v.capacitySigned) || 0,
    })),
  );

  const headerWeeks: HeaderWeek[] = board.cards.map((c) => {
    const [done, total] = (c.list[0] ?? '0 / 0')
      .split('/')
      .map((x) => Number(x.trim()) || 0);

    return {
      week: c.month,
      status: c.status,
      submitted: done,
      total,
    };
  });

  return (
    <FormLayout
      title="Vendor Capacity"
      active="/vendor-capacity"
      role={user.role}
      userEmail={user.email}
      allowedPages={user.allowed_pages ?? null}
    >
      <WeekHeader
        weeks={headerWeeks}
        shown={asOf?.week ?? curWeek}
        current={curWeek}
      />

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