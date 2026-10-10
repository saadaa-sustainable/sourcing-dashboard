import 'server-only';
// Vendor Capacity — monthly analysis of the weekly input (user, 2026-10-09: "Weekly input,
// monthly analysis. Mandatory monthly report to management.").
//
// Capacity is entered weekly (Mon–Sun, IST). A month is the weeks whose Monday falls in it. For
// each week: who updated, capacity as declared by the end of the week, PO capacity, and the
// quantity on order from the weekly copy (sd_vendor_in_process_weekly). Utilisation always goes
// through src/lib/utilisation.ts when shown. `db` lets the month-close cron read with the
// service-role client; the page passes nothing and reads as the signed-in user.

import { client, pageAll } from '@/lib/forms/queries-modules/_shared';
import { loadCapacityEvents, type CapacityEvent } from '@/lib/forms/queries-modules/month-boards';
import { ANALYTICS_RULE_DEFAULTS } from '@/lib/forms/queries-modules/analytics';
import { addMonths, capacityWeekStart, monthLabel, monthStart } from '@/lib/forms/approval';
import { capacityRulesFrom, eeVendorActive, vendorCapacityModel } from '@/lib/business-logic';
import type { VcmVendor, VcmWeek, VendorCapacityMonth } from './vendor-capacity-month-types';

type Db = Awaited<ReturnType<typeof client>>;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const addDays = (iso: string, k: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
const dm = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
const weekLabel = (w: string) => {
  const end = addDays(w, 6);
  return w.slice(5, 7) === end.slice(5, 7) ? `${Number(w.slice(8, 10))} – ${dm(end)}` : `${dm(w)} – ${dm(end)}`;
};
const key = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();
/** The change trail behind week-by-week capacity starts with the week of 1 Oct 2026. */
const TRAIL_WEEK = capacityWeekStart(new Date('2026-10-01T06:00:00Z'));

/** Mondays that fall in `month`, up to the running week. */
export function monthWeeks(month: string): string[] {
  const next = addMonths(month, 1);
  const cur = capacityWeekStart();
  const out: string[] = [];
  let d = month;
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  for (; d < next && d <= cur; d = addDays(d, 7)) out.push(d);
  return out;
}

type Master = { vendor_code: string | null; vendor_name: string | null; primary_type: string | null; ee_status: string | null; capacity_per_month: number | null };
type TypeRow = { vendor_code: string | null; vendor_name: string | null; vendor_type: string | null; status: string | null };

/** Active vendors — the same rule as the Vendor Capacity page (EasyEcom status, else the type master). */
async function activeVendors(db: Db) {
  const [masters, types] = await Promise.all([
    pageAll<Master>(() => db.from('vendor_master_data').select('vendor_code, vendor_name, primary_type, ee_status, capacity_per_month').order('vendor_code')),
    pageAll<TypeRow>(() => db.from('vendor_type_master').select('vendor_code, vendor_name, vendor_type, status').order('vendor_name')),
  ]);
  const statusByCode = new Map(types.map((t) => [key(t.vendor_code), t.status]));
  const statusByName = new Map(types.map((t) => [key(t.vendor_name), t.status]));
  const typeByCode = new Map(types.map((t) => [key(t.vendor_code), t.vendor_type ?? '']));
  return masters
    .filter((m) => {
      if (!key(m.vendor_code)) return false;
      const ee = eeVendorActive(m.ee_status);
      if (ee !== null) return ee;
      return key(statusByCode.get(key(m.vendor_code)) ?? statusByName.get(key(m.vendor_name))) === 'active';
    })
    .map((m) => ({
      code: key(m.vendor_code),
      display: m.vendor_code as string,
      name: m.vendor_name || (m.vendor_code as string),
      type: m.primary_type || typeByCode.get(key(m.vendor_code)) || '',
      signed: Number(m.capacity_per_month) || 0,
    }));
}

async function capacityRules(db: Db) {
  const rules: Record<string, number> = { ...ANALYTICS_RULE_DEFAULTS };
  const { data } = await db.from('sd_analytics_rule').select('rule_key, value');
  for (const r of (data ?? []) as { rule_key: string; value: number }[]) {
    const v = Number(r.value);
    if (Number.isFinite(v)) rules[r.rule_key] = v;
  }
  return capacityRulesFrom(rules);
}

export async function loadVendorCapacityMonth(month: string = monthStart(), db?: Db): Promise<VendorCapacityMonth> {
  const supabase = db ?? (await client());
  const weeks = monthWeeks(month);
  const closed = month < monthStart();
  const cur = capacityWeekStart();

  const [vendors, events, rules, copies] = await Promise.all([
    activeVendors(supabase),
    loadCapacityEvents(supabase),
    capacityRules(supabase),
    weeks.length
      ? pageAll<{ week: string; vendor_code: string; in_process_qty: number | null }>(() =>
          supabase.from('sd_vendor_in_process_weekly').select('week, vendor_code, in_process_qty').in('week', weeks).order('week').order('vendor_code'),
        )
      : Promise.resolve([]),
  ]);

  // Quantity on order at each week's end, from the weekly copy (null = no copy for that week).
  const copyByWeek = new Map<string, Map<string, number>>();
  for (const c of copies) {
    const m = copyByWeek.get(c.week) ?? new Map<string, number>();
    m.set(key(c.vendor_code), Number(c.in_process_qty) || 0);
    copyByWeek.set(c.week, m);
  }
  const weekOf = (ts: string) => capacityWeekStart(new Date(ts));
  const lastBy = (until: number) => {
    const out = new Map<string, CapacityEvent>();
    for (const e of events) {
      const t = Date.parse(e.at);
      if (!(t < until)) continue;
      const had = out.get(e.vendor);
      if (!had || Date.parse(had.at) < t) out.set(e.vendor, e);
    }
    return out;
  };

  type Cell = { capacity: number | null; poCap: number | null; onOrder: number | null; util: number | null; over: boolean; updated: boolean };
  const cells = new Map<string, Cell[]>(vendors.map((v) => [v.code, []]));
  const weekRows: VcmWeek[] = weeks.map((w) => {
    const asOf = lastBy(Date.parse(`${addDays(w, 7)}T00:00:00+05:30`));
    const updatedSet = new Set(events.filter((e) => weekOf(e.at) === w).map((e) => e.vendor));
    const copy = copyByWeek.get(w) ?? null;
    let capacityPerMonth = 0;
    let poCapacity = 0;
    let onOrder = 0;
    let poCapWithCopy = 0;
    let overVendors = 0;
    let updated = 0;
    for (const v of vendors) {
      const e = asOf.get(v.code);
      const ord = copy ? (copy.get(v.code) ?? 0) : null;
      const m = vendorCapacityModel({ machines: e?.machines ?? null, karigar: e?.karigar ?? null, vendorType: v.type, inProcessQty: ord ?? 0 }, rules);
      const isUpdated = updatedSet.has(v.code);
      if (isUpdated) updated += 1;
      if (m.entered) {
        capacityPerMonth += m.capacityPerMonth;
        poCapacity += m.poCapacity;
        if (ord != null) poCapWithCopy += m.poCapacity;
      }
      if (ord != null) onOrder += ord;
      const over = ord != null && m.over;
      if (over) overVendors += 1;
      cells.get(v.code)!.push({
        capacity: m.entered ? m.capacityPerMonth : null,
        poCap: m.entered ? m.poCapacity : null,
        onOrder: ord,
        util: ord != null && m.entered ? m.capacityUtil : null,
        over,
        updated: isUpdated,
      });
    }
    return {
      week: w,
      label: weekLabel(w),
      updated,
      active: vendors.length,
      capacityPerMonth,
      poCapacity,
      onOrder: copy ? onOrder : null,
      util: copy && poCapWithCopy > 0 ? Math.round((onOrder / poCapWithCopy) * 1000) / 10 : null,
      overVendors: copy ? overVendors : null,
      running: w === cur,
    };
  });

  const lastAt = lastBy(Date.parse(`${addDays(weeks[weeks.length - 1] ?? month, 7)}T00:00:00+05:30`));
  const vendorRows: VcmVendor[] = vendors
    .map((v) => {
      const cs = cells.get(v.code) ?? [];
      const utils = cs.map((c) => c.util).filter((u): u is number => u != null);
      const first = cs[0];
      const last = cs[cs.length - 1];
      return {
        code: v.display,
        name: v.name,
        type: v.type || null,
        signed: v.signed,
        weeksUpdated: cs.filter((c) => c.updated).length,
        weeksExpected: cs.length,
        capStart: first?.capacity ?? null,
        capEnd: last?.capacity ?? null,
        poCapEnd: last?.poCap ?? null,
        onOrderEnd: last?.onOrder ?? null,
        avgUtil: utils.length ? Math.round((utils.reduce((t, u) => t + u, 0) / utils.length) * 10) / 10 : null,
        peakUtil: utils.length ? Math.max(...utils) : null,
        weeksOver: cs.filter((c) => c.over).length,
        lastUpdate: lastAt.get(v.code)?.at ?? null,
      };
    })
    .sort((a, b) => (b.peakUtil ?? -1) - (a.peakUtil ?? -1) || a.name.localeCompare(b.name));

  const expected = vendorRows.reduce((t, v) => t + v.weeksExpected, 0);
  const done = vendorRows.reduce((t, v) => t + v.weeksUpdated, 0);
  const lastWeek = weekRows[weekRows.length - 1];
  const firstWeek = weekRows[0];
  const noCopy = weekRows.filter((w) => w.onOrder == null).map((w) => w.label);
  const notes = [
    'A week belongs to the month its Monday falls in.',
    'Capacity per month and PO capacity use the same calculation as the capacity sheet, from the machines and karigar each vendor had declared by the end of the week.',
    ...(weeks.some((w) => w < TRAIL_WEEK)
      ? ['Weeks before October 2026 are incomplete: only each vendor’s latest update was kept then, so earlier updates that were later replaced are missing.']
      : []),
    ...(noCopy.length ? [`No end-of-week copy of the quantity on order was kept for ${noCopy.join(', ')}; on order and capacity used are left blank for ${noCopy.length === 1 ? 'that week' : 'those weeks'}.`] : []),
    ...(!closed ? ['The month is still running: figures change as vendors are updated.'] : []),
  ];

  return {
    month,
    label: monthLabel(month),
    closed,
    weeks: weekRows,
    vendors: vendorRows,
    totals: {
      active: vendors.length,
      vendorWeeksUpdated: done,
      vendorWeeksExpected: expected,
      compliancePct: expected ? Math.round((done / expected) * 1000) / 10 : null,
      neverUpdated: vendorRows.filter((v) => v.weeksExpected > 0 && v.weeksUpdated === 0).length,
      overAnyWeek: vendorRows.filter((v) => v.weeksOver > 0).length,
      capStart: firstWeek?.capacityPerMonth ?? 0,
      capEnd: lastWeek?.capacityPerMonth ?? 0,
      poCapEnd: lastWeek?.poCapacity ?? 0,
      onOrderEnd: lastWeek?.onOrder ?? null,
      utilEnd: lastWeek?.util ?? null,
    },
    notes,
    generatedAt: new Date().toISOString(),
  };
}

/** The month's report-to-management registry row (sd_plan_report), read as the signed-in user. */
export async function loadVendorCapacityReportStatus(month: string): Promise<import('./vendor-capacity-month-types').VendorCapacityReportStatus> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_plan_report')
    .select('generated_at, generated_by, slack_posted_at, slack_error, storage_path')
    .eq('plan_month', month)
    .eq('plan_type', 'vendor_capacity')
    .maybeSingle();
  const r = data as { generated_at: string; generated_by: string | null; slack_posted_at: string | null; slack_error: string | null; storage_path: string } | null;
  return r ? { generatedAt: r.generated_at, generatedBy: r.generated_by, slackPostedAt: r.slack_posted_at, slackError: r.slack_error, storagePath: r.storage_path } : null;
}
