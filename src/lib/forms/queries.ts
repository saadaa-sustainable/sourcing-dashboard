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
  InwardPlanGroup,
  PoApproval,
  PoCycleTime,
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

/** Every provisioned user, for the admin-only User Panel. */
export async function loadUsers(): Promise<SdUser[]> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_user')
    .select('email, full_name, role, is_active')
    .order('is_active', { ascending: false })
    .order('email');
  return (data ?? []) as SdUser[];
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

  // Product status + woven/knitted come from the master, read-only. Nulls until
  // the master is populated — the Buying Plan never lets these be typed.
  const { data: master } = await supabase
    .from('sd_product_master')
    .select('product_code, product_status, fabric_type')
    .limit(PAGE_SIZE);
  const productMaster: Record<string, { status: string | null; fabric_type: string | null }> = {};
  (
    (master ?? []) as {
      product_code: string;
      product_status: string | null;
      fabric_type: string | null;
    }[]
  ).forEach((m) => {
    productMaster[m.product_code] = {
      status: m.product_status,
      fabric_type: m.fabric_type,
    };
  });

  return {
    plan: (plan as BuyingPlan | null) ?? null,
    lines,
    productCodes,
    productMaster,
    planMonth,
  };
}

/**
 * Actual issued quantity/value for the plan month, from the PO pipeline view
 * (sd_po_actuals_by_product_month = real EasyCom POs). Advisory — never blocks.
 */
export async function loadActualsByProduct(planMonth: string) {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_po_actuals_by_product_month')
    .select('product_code, issued_qty, issued_value')
    .eq('plan_month', planMonth);

  const map = new Map<string, { qty: number; value: number }>();
  (
    (data ?? []) as {
      product_code: string | null;
      issued_qty: number | null;
      issued_value: number | null;
    }[]
  ).forEach((row) => {
    const code = (row.product_code ?? '').trim();
    if (!code) return;
    map.set(code, {
      qty: Number(row.issued_qty) || 0,
      value: Number(row.issued_value) || 0,
    });
  });
  return map;
}

/**
 * In-process (Approved) quantity per vendor, from the PO pipeline view
 * (sd_vendor_in_process). Feeds Vendor Capacity's available-capacity — real PO
 * load instead of the sheet's open-qty. Keyed by lower-cased vendor_code.
 */
export async function loadInProcessByVendor(): Promise<Map<string, number>> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_in_process')
    .select('vendor_code, in_process_qty');

  const map = new Map<string, number>();
  (
    (data ?? []) as { vendor_code: string | null; in_process_qty: number | null }[]
  ).forEach((row) => {
    const code = (row.vendor_code ?? '').trim().toLowerCase();
    if (code) map.set(code, Number(row.in_process_qty) || 0);
  });
  return map;
}

/**
 * Each vendor's most recently logged monthly capacity (sd_vendor_capacity_log),
 * so the PO approval card can show "last-updated capacity". Keyed lower-case.
 */
export async function loadLatestVendorCapacity(): Promise<
  Map<string, { capacityPerMonth: number; weekOf: string | null }>
> {
  const supabase = await client();
  const { data } = await supabase
    .from('sd_vendor_capacity_log')
    .select('vendor_code, capacity_per_month, week_of')
    .order('week_of', { ascending: false });

  const map = new Map<string, { capacityPerMonth: number; weekOf: string | null }>();
  (
    (data ?? []) as {
      vendor_code: string | null;
      capacity_per_month: number | null;
      week_of: string | null;
    }[]
  ).forEach((row) => {
    const code = (row.vendor_code ?? '').trim().toLowerCase();
    // Rows arrive newest-first, so the first one seen per vendor is the latest.
    if (code && !map.has(code)) {
      map.set(code, {
        capacityPerMonth: Number(row.capacity_per_month) || 0,
        weekOf: row.week_of ?? null,
      });
    }
  });
  return map;
}

/**
 * Inward Plan — arriving stock from open (Approved) POs, grouped to colour level
 * (po_number × product_code × product_variant) off sd_po_lines_enriched.
 * Only lines with pending qty > 0 (still to arrive). Soonest EDD first.
 */
export async function loadInwardPlan(): Promise<InwardPlanGroup[]> {
  const supabase = await client();
  const rows: Record<string, unknown>[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from('sd_po_lines_enriched')
      .select(
        'po_number, po_ref_num, product_code, product_variant, vendor_code, vendor_name, pending_qty, original_qty, expected_delivery_date',
      )
      .eq('po_status_code', 3)
      .gt('pending_qty', 0)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`sd_po_lines_enriched: ${error.message}`);
    if (!data?.length) break;
    rows.push(...(data as Record<string, unknown>[]));
    if (data.length < PAGE_SIZE) break;
  }

  const groups = new Map<string, InwardPlanGroup>();
  for (const r of rows) {
    const po_number = String(r.po_number ?? '');
    const product_code = String(r.product_code ?? '');
    const product_variant = String(r.product_variant ?? '');
    const arriving = Number(r.pending_qty) || 0;
    const ordered = Number(r.original_qty) || 0;
    const edd = (r.expected_delivery_date as string | null) ?? null;
    const k = `${po_number}${product_code}${product_variant}`;
    const g = groups.get(k);
    if (g) {
      g.arriving_qty += arriving;
      g.ordered_qty += ordered;
      if (edd && (!g.expected_delivery_date || edd < g.expected_delivery_date)) {
        g.expected_delivery_date = edd;
      }
    } else {
      groups.set(k, {
        po_number,
        po_ref_num: (r.po_ref_num as string | null) ?? null,
        product_code,
        product_variant,
        vendor_code: String(r.vendor_code ?? ''),
        vendor_name: String(r.vendor_name ?? ''),
        ordered_qty: ordered,
        arriving_qty: arriving,
        expected_delivery_date: edd,
      });
    }
  }

  return [...groups.values()].sort((a, b) => {
    if (!a.expected_delivery_date) return 1;
    if (!b.expected_delivery_date) return -1;
    return a.expected_delivery_date.localeCompare(b.expected_delivery_date);
  });
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
/* PO Approval                                                         */
/* ------------------------------------------------------------------ */

/**
 * Everything the PO Approval screen needs: the POs themselves, their cycle-time
 * rows (sd_po_cycle_time), the product/vendor pick-lists for the entry form, and
 * each vendor's live in-process load (sd_vendor_in_process) for the cards.
 */
export async function loadPoApprovals() {
  const supabase = await client();

  const [{ data: pos }, { data: cycle }, { data: variants }] = await Promise.all([
    supabase
      .from('sd_po_approval')
      .select('*')
      .order('id', { ascending: false })
      .limit(500),
    supabase.from('sd_po_cycle_time').select('*').limit(500),
    supabase.from('sd_active_variants').select('product_code').limit(PAGE_SIZE),
  ]);

  const capacityByVendor = await loadInProcessByVendor();

  const productCodes = [
    ...new Set(
      ((variants ?? []) as { product_code: string }[])
        .map((r) => r.product_code)
        .filter(Boolean),
    ),
  ].sort();

  const vendorCodes = [...capacityByVendor.keys()].sort();

  const cycleById = new Map<number, PoCycleTime>();
  ((cycle ?? []) as PoCycleTime[]).forEach((c) => cycleById.set(c.id, c));

  return {
    pos: (pos ?? []) as PoApproval[],
    cycleById,
    productCodes,
    vendorCodes,
    capacityByVendor,
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

  const [{ data: plans }, { data: discontinues }, { data: pos }, { data: log }] =
    await Promise.all([
      supabase
        .from('sd_buying_plan')
        .select('*')
        .in('status', ['submitted', 'pending_l2']),
      supabase
        .from('sd_discontinue_request')
        .select('*')
        .in('status', ['submitted', 'pending_l2']),
      supabase
        .from('sd_po_approval')
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

  if ((pos ?? []).length) {
    const [inProcessByVendor, latestCapacity] = await Promise.all([
      loadInProcessByVendor(),
      loadLatestVendorCapacity(),
    ]);
    for (const po of (pos ?? []) as PoApproval[]) {
      const qty = Number(po.po_qty || 0);
      const vendor = (po.vendor_code ?? '').trim();
      const cap = vendor ? latestCapacity.get(vendor.toLowerCase()) : undefined;
      items.push({
        entityType: 'po_approval',
        entityId: String(po.id),
        label: `PO ${po.po_ref_num ?? `#${po.id}`} — ${po.category.toUpperCase()}`,
        sublabel: `${po.product_code ?? '—'} · ${po.vendor_name || vendor || '—'} · ${qty.toLocaleString('en-IN')} pcs`,
        status: po.status,
        quantity: qty,
        requiredRole: routeApproval('po_approval', qty, po.category),
        submittedBy: po.created_by,
        submittedAt: po.submitted_for_approval_at,
        href: '/po-approval',
        vendorCode: vendor || null,
        vendorInProcessQty: vendor
          ? inProcessByVendor.get(vendor.toLowerCase()) ?? null
          : null,
        vendorCapacityPerMonth: cap?.capacityPerMonth ?? null,
        vendorCapacityUpdatedAt: cap?.weekOf ?? null,
      });
    }
  }

  items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return { items, log: (log ?? []) as ApprovalLogRow[] };
}
