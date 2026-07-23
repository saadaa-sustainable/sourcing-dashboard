import 'server-only';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { buildVendorRollups } from '@/lib/business-logic';
import { loadDashboardData } from '@/lib/data';
import { monthStart, weekStart } from './approval';
import type {
  ApprovalQueueItem,
  ApprovalLogRow,
  BuyingPlan,
  BuyingPlanLine,
  BuyingPlanLineView,
  DiscontinueRequest,
  SdUser,
  VendorCapacityLog,
  VendorCapacityView,
  VendorTypeMultiplier,
} from './types';
import { routeApproval } from './approval';

/**
 * Reads for the write-side tables.
 *
 * PostgREST caps a response at 1000 rows, so anything that can grow past that
 * pages explicitly — same reason `fetchAllRows` exists in lib/data.ts.
 */
const PAGE_SIZE = 1000;

export class NotConfiguredError extends Error {
  constructor() {
    super(
      'Supabase is not configured. Workflow forms cannot run against local fixtures — set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
    this.name = 'NotConfiguredError';
  }
}

async function client() {
  if (!hasSupabaseEnv()) throw new NotConfiguredError();
  return createClient();
}

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

export async function currentUser(): Promise<SdUser | null> {
  const supabase = await client();
  const { data: claims } = await supabase.auth.getClaims();
  const email =
    typeof claims?.claims?.email === 'string'
      ? claims.claims.email.toLowerCase()
      : null;
  if (!email) return null;

  const { data } = await supabase
    .from('sd_user')
    .select('email, full_name, role, is_active')
    .eq('email', email)
    .maybeSingle();

  // Someone signed in with a valid @saadaa.in account but was never added to
  // sd_user. Treat as viewer rather than crashing — an admin adds them later.
  return (
    (data as SdUser | null) ?? {
      email,
      full_name: null,
      role: 'viewer',
      is_active: true,
    }
  );
}

/* ------------------------------------------------------------------ */
/* Buying plan                                                         */
/* ------------------------------------------------------------------ */

export async function loadBuyingPlan(planMonth = monthStart()) {
  const supabase = await client();

  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('*')
    .eq('plan_month', planMonth)
    .maybeSingle();

  const lines: BuyingPlanLine[] = [];
  if (plan) {
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('sd_buying_plan_line')
        .select('*')
        .eq('plan_id', (plan as BuyingPlan).id)
        .order('product_code')
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw new Error(`sd_buying_plan_line: ${error.message}`);
      if (!data?.length) break;
      lines.push(...(data as BuyingPlanLine[]));
      if (data.length < PAGE_SIZE) break;
    }
  }

  // Active variants only — the view already subtracts approved discontinues.
  const { data: variants } = await supabase
    .from('sd_active_variants')
    .select('product_code')
    .limit(PAGE_SIZE);

  const productCodes = [
    ...new Set(
      ((variants ?? []) as { product_code: string }[])
        .map((r) => r.product_code)
        .filter(Boolean),
    ),
  ].sort();

  return {
    plan: (plan as BuyingPlan | null) ?? null,
    lines,
    productCodes,
    planMonth,
  };
}

/**
 * Actual issued quantity/value, joined live off the read-only PO mirror.
 * Never stored on the plan — it changes every time the sheet syncs.
 */
export async function loadActualsByProduct(planMonth: string) {
  const supabase = await client();
  const [y, m] = planMonth.split('-').map(Number);
  const from = planMonth;
  const to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);

  const rows: { product_code: string | null; original_quantity: number; item_price: number }[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('pending_po_master')
      .select('product_code, original_quantity, item_price')
      .eq('is_active', true)
      .gte('po_date', from)
      .lt('po_date', to)
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) break; // actuals are advisory — never block the form
    if (!data?.length) break;
    rows.push(...(data as typeof rows));
    if (data.length < PAGE_SIZE) break;
  }

  const map = new Map<string, { qty: number; value: number }>();
  rows.forEach((row) => {
    const code = (row.product_code ?? '').trim();
    if (!code) return;
    const current = map.get(code) ?? { qty: 0, value: 0 };
    const qty = Number(row.original_quantity) || 0;
    current.qty += qty;
    current.value += qty * (Number(row.item_price) || 0);
    map.set(code, current);
  });
  return map;
}

export function buildBuyingPlanView(
  lines: BuyingPlanLine[],
  actuals: Map<string, { qty: number; value: number }>,
): BuyingPlanLineView[] {
  return lines.map((line) => {
    const totalQty =
      Number(line.job_work_qty || 0) +
      Number(line.fob_qty || 0) +
      Number(line.efob_qty || 0);
    const valueToBeBought = totalQty * Number(line.standard_value || 0);
    const actual = actuals.get(line.product_code) ?? { qty: 0, value: 0 };
    return {
      ...line,
      totalQty,
      valueToBeBought,
      actualIssuedQty: actual.qty,
      actualIssuedValue: actual.value,
      // Shown in red. Deliberately does NOT block submission.
      overPlan: actual.qty > totalQty && totalQty > 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Vendor capacity                                                     */
/* ------------------------------------------------------------------ */

export async function loadVendorCapacity(week = weekStart()) {
  const supabase = await client();

  const { data: logs } = await supabase
    .from('sd_vendor_capacity_log')
    .select('*')
    .eq('week_of', week)
    .order('vendor_code');

  const { data: multipliers } = await supabase
    .from('sd_vendor_type_multiplier')
    .select('*');

  // Previous week, so the form can prefill instead of starting blank.
  const prevWeek = new Date(new Date(`${week}T00:00:00Z`).getTime() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const { data: prior } = await supabase
    .from('sd_vendor_capacity_log')
    .select('*')
    .eq('week_of', prevWeek);

  const dashboard = await loadDashboardData();
  const rollups = buildVendorRollups(
    dashboard.pendingPos,
    dashboard.vendorTypes,
    dashboard.vendorMasters,
    dashboard.tnaRecords,
  );

  return {
    week,
    logs: (logs ?? []) as VendorCapacityLog[],
    priorLogs: (prior ?? []) as VendorCapacityLog[],
    multipliers: (multipliers ?? []) as VendorTypeMultiplier[],
    rollups,
    vendorMasters: dashboard.vendorMasters,
    vendorTypes: dashboard.vendorTypes,
  };
}

export function buildCapacityView(
  logs: VendorCapacityLog[],
  multipliers: VendorTypeMultiplier[],
  inProcessByVendor: Map<string, number>,
  vendorTypeByCode: Map<string, string>,
): VendorCapacityView[] {
  const multiplierByType = new Map(
    multipliers.map((m) => [m.vendor_type.toLowerCase(), m]),
  );

  return logs.map((log) => {
    const rawType = (vendorTypeByCode.get(log.vendor_code.toLowerCase()) ?? '').toLowerCase();
    const normalised = rawType.includes('job')
      ? 'job_work'
      : rawType.includes('e-fob') || rawType.includes('efob')
        ? 'efob'
        : rawType.includes('fob')
          ? 'fob'
          : 'job_work';
    const config = multiplierByType.get(normalised);
    const multiplier = config?.multiplier ?? 1;
    const capacity = Number(log.capacity_per_month || 0);
    const inProcess = inProcessByVendor.get(log.vendor_code.toLowerCase()) ?? 0;
    const poCapacity = capacity * multiplier;
    const available = poCapacity - inProcess;

    return {
      ...log,
      vendorType: normalised,
      multiplier,
      stockDays: config?.stock_days ?? 0,
      inProcessQty: inProcess,
      poCapacity,
      availablePoCapacity: available,
      overProduction: available < 0,
      machineUtilisationPct:
        Number(log.machines_at_onboarding || 0) > 0
          ? Math.round(
              (Number(log.machines_allocated || 0) /
                Number(log.machines_at_onboarding)) *
                100,
            )
          : 0,
      capacityUtilisationPct: poCapacity
        ? Math.round((inProcess / poCapacity) * 100)
        : 0,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Discontinue                                                         */
/* ------------------------------------------------------------------ */

export async function loadDiscontinueRequests() {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_discontinue_request')
    .select('*')
    .order('id', { ascending: false })
    .limit(500);

  const { data: variants } = await supabase
    .from('sd_active_variants')
    .select('product_code, product_variant')
    .limit(PAGE_SIZE);

  return {
    requests: (data ?? []) as DiscontinueRequest[],
    variants: (variants ?? []) as { product_code: string; product_variant: string }[],
  };
}

/* ------------------------------------------------------------------ */
/* Approvals queue                                                     */
/* ------------------------------------------------------------------ */

export async function loadApprovalQueue(): Promise<{
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
}> {
  const supabase = await client();

  const [{ data: plans }, { data: discontinues }, { data: log }] = await Promise.all([
    supabase
      .from('sd_buying_plan')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_approval_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const items: ApprovalQueueItem[] = [];

  for (const plan of (plans ?? []) as BuyingPlan[]) {
    const { data: lines } = await supabase
      .from('sd_buying_plan_line')
      .select('job_work_qty, fob_qty, efob_qty')
      .eq('plan_id', plan.id);
    const qty = ((lines ?? []) as BuyingPlanLine[]).reduce(
      (sum, l) =>
        sum +
        Number(l.job_work_qty || 0) +
        Number(l.fob_qty || 0) +
        Number(l.efob_qty || 0),
      0,
    );
    items.push({
      entityType: 'buying_plan',
      entityId: String(plan.id),
      label: `Buying plan — ${plan.plan_month.slice(0, 7)}`,
      sublabel: `${((lines ?? []) as unknown[]).length} product codes · ${qty.toLocaleString('en-IN')} pcs`,
      status: plan.status,
      quantity: qty,
      requiredRole: routeApproval('buying_plan', qty),
      submittedBy: plan.submitted_by,
      submittedAt: plan.submitted_at,
      href: `/buying-plan?month=${plan.plan_month}`,
    });
  }

  for (const req of (discontinues ?? []) as DiscontinueRequest[]) {
    items.push({
      entityType: 'discontinue',
      entityId: String(req.id),
      label: `Discontinue — ${req.product_code} / ${req.product_variant}`,
      sublabel: req.reason ?? 'No reason given',
      status: req.status,
      quantity: 0,
      requiredRole: routeApproval('discontinue'),
      submittedBy: req.requested_by,
      submittedAt: req.requested_at,
      href: '/discontinue',
    });
  }

  items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return { items, log: (log ?? []) as ApprovalLogRow[] };
}
