import 'server-only';
import { client, PAGE_SIZE, pageAll } from './_shared';
import { buildTrackerRows } from '@/lib/business-logic';
import { loadDashboardData } from '@/lib/data';
import { monthStart, weekStart } from '../approval';
import { countPendingApprovals } from './approvals';
import type { CashFlowMonth, VendorTerm, SyncStatusRow, PpmPrep } from '../types';

/** Cash-flow forecast (payment obligations by month) + editable vendor terms. */
export async function loadCashFlow(): Promise<{
  months: CashFlowMonth[];
  vendorTerms: VendorTerm[];
}> {
  const supabase = await client();
  const [{ data: rows }, { data: terms }] = await Promise.all([
    supabase.from('sd_cash_flow_by_month').select('source, due_month, amount, items'),
    supabase
      .from('sd_vendor_payment_terms')
      .select('vendor_code, vendor_name, payment_terms_days')
      .order('vendor_code'),
  ]);

  const byMonth = new Map<string, CashFlowMonth>();
  (
    (rows ?? []) as { source: string; due_month: string; amount: number; items: number }[]
  ).forEach((r) => {
    const cur =
      byMonth.get(r.due_month) ??
      { due_month: r.due_month, received: 0, projected: 0, total: 0, items: 0 };
    const amt = Number(r.amount) || 0;
    if (r.source === 'received') cur.received += amt;
    else cur.projected += amt;
    cur.total += amt;
    cur.items += Number(r.items) || 0;
    byMonth.set(r.due_month, cur);
  });

  return {
    months: [...byMonth.values()].sort((a, b) => a.due_month.localeCompare(b.due_month)),
    vendorTerms: (terms ?? []) as VendorTerm[],
  };
}

/**
 * PPM Prep rollup (item 3) — assembles the numbers manually compiled before the
 * Production Planning Meeting from their existing sources, so it's a consolidation
 * not a recomputation. Each section links out to its detailed page in the UI.
 */
export async function loadPpmPrep(): Promise<PpmPrep> {
  const supabase = await client();
  const wkStart = weekStart();
  const planMonth = monthStart();

  // Month window [planMonth, next month) for the receivable-vs-GRN rollup.
  const monthEnd = (() => {
    const d = new Date(`${planMonth}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();

  const [rep, pending, issuance, approvalsWk, expected, received, dash] = await Promise.all([
    // OOS / OS % — sd_replenishment (the existing OOS source; no DOQ rebuild needed).
    supabase.from('sd_replenishment').select('oos_flag', { count: 'exact' }).limit(1),
    countPendingApprovals(),
    // POs approved but not yet issued.
    supabase
      .from('sd_po_approval')
      .select('po_qty', { count: 'exact' })
      .eq('status', 'approved')
      .is('po_issued_at', null)
      .limit(PAGE_SIZE),
    // Cost/standard approvals this week (issued or approved since Monday).
    supabase
      .from('sd_po_approval')
      .select('id', { count: 'exact', head: true })
      .gte('approved_at', wkStart),
    // Arrivals status (this month) — what the team expected in the Receivable Plan
    // for delivery this month vs what GRN recorded as received this month.
    // Paged (GRN is line-level and a month runs well past 1000 rows). Planned counts
    // only expectations the team actually put forward (submitted/approved), not
    // drafts or rejected rows.
    pageAll<{ qty_expected_this_week: number | null }>(() =>
      supabase
        .from('sd_receivable_input')
        .select('qty_expected_this_week')
        .in('status', ['submitted', 'pending_l2', 'approved'])
        .gte('delivery_date_this_week', planMonth)
        .lt('delivery_date_this_week', monthEnd)
        .order('row_key'),
    ),
    pageAll<{ received_quantity: number | null }>(() =>
      supabase
        .from('sd_ee_grn')
        .select('received_quantity')
        .gte('grn_created_at', planMonth)
        .lt('grn_created_at', monthEnd)
        .order('grn_detail_id'),
    ),
    loadDashboardData(),
  ]);

  /* Out of stock right now = no sellable stock on hand.

     This used to count `oos_flag`, which is NOT what it sounds like: it is true when a
     variant was out of stock on ANY day of the last 45, so it stays true for a variant that
     was refilled weeks ago and is sitting on plenty. It reported 658 of 669 variants, 98%,
     while only 13 actually had nothing on hand. Flagged variants even held MORE average stock
     (558) than unflagged ones (427), which is the giveaway that the flag is about history,
     not about today.

     The days-out-of-stock history is still worth watching, but it belongs beside this number
     under its own name, not inside it. */
  let oos: PpmPrep['oos'] = null;
  try {
    const { count: total } = await supabase
      .from('sd_replenishment')
      .select('*', { count: 'exact', head: true });
    const { count: oosCount } = await supabase
      .from('sd_replenishment')
      .select('*', { count: 'exact', head: true })
      .lte('current_stock', 0);
    if (total != null) {
      oos = {
        total,
        oos: oosCount ?? 0,
        pct: total > 0 ? Math.round(((oosCount ?? 0) / total) * 100) : 0,
      };
    }
  } catch {
    oos = null;
  }
  void rep;

  const issuanceRows = (issuance.data ?? []) as { po_qty: number | null }[];
  const pendingIssuance = {
    count: issuance.count ?? issuanceRows.length,
    qty: issuanceRows.reduce((s, r) => s + (Number(r.po_qty) || 0), 0),
  };

  const expectedRows = expected;
  const receivedRows = received;
  const inwardTotals = {
    planned: expectedRows.reduce((s, r) => s + (Number(r.qty_expected_this_week) || 0), 0),
    actual: receivedRows.reduce((s, r) => s + (Number(r.received_quantity) || 0), 0),
  };

  // PO audit — High Risk / Overdue open POs, with the offending stage as the "why".
  const tracker = buildTrackerRows(dash.pendingPos, dash.vendorTypes, dash.vendorMasters, dash.tnaRecords);
  const risky = tracker.filter((r) => r.internalStatus === 'High Risk' || r.internalStatus === 'Overdue');
  const highRisk = {
    count: risky.filter((r) => r.internalStatus === 'High Risk').length,
    overdue: risky.filter((r) => r.internalStatus === 'Overdue').length,
    top: risky
      .slice(0, 12)
      .map((r) => ({ poRef: r.poRef, vendor: r.vendorName, stage: r.stage, status: r.internalStatus })),
  };

  return {
    weekStart: wkStart,
    planMonth,
    oos,
    pendingApproval: pending,
    pendingIssuance,
    approvalsThisWeek: approvalsWk.count ?? 0,
    inward: inwardTotals,
    highRisk,
  };
}

/** Per-source data freshness for the Sync Health tab (sd_sync_status view). */
export async function loadSyncStatus(): Promise<SyncStatusRow[]> {
  const supabase = await client();
  const { data, error } = await supabase
    .from('sd_sync_status')
    .select('*')
    .order('pipeline')
    .order('source');
  if (error) throw new Error(`sd_sync_status: ${error.message}`);
  return (data ?? []) as SyncStatusRow[];
}
