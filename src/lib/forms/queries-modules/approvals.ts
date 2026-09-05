import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import { canApprove, routeApproval } from '../approval';
import { loadApprovedStandardCosts, loadApprovedMaterialCosts } from './standard-cost';
import { loadInProcessByVendor, loadLatestVendorCapacity } from './vendor';
import type {
  ApprovalNotification,
  ApprovalQueueItem,
  ApprovalLogRow,
  MyDashboardData,
  MySubmission,
  SdRole,
  SdStatus,
  BuyingPlan,
  BuyingPlanLine,
  DiscontinueRequest,
  PoApproval,
} from '../types';

/** Cheap count of items in the shared approval queue, for the notification bell. */
export async function countPendingApprovals(): Promise<number> {
  const supabase = await client();
  const pending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('status', ['submitted', 'pending_l2']);
  // Cost negotiation runs outside the status ladder: proposed / rate_submitted
  // are the admin's turn (the bell renders for admins only).
  const costPending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('neg_stage', ['proposed', 'rate_submitted']);
  const [a, b, c, d, e] = await Promise.all([
    pending('sd_buying_plan'),
    pending('sd_discontinue_request'),
    pending('sd_po_approval'),
    costPending('sd_standard_cost'),
    costPending('sd_material_standard_cost'),
  ]);
  return (a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0) + (d.count ?? 0) + (e.count ?? 0);
}

/**
 * Lightweight list behind the topbar notification bell: the pending items this
 * user can act on (same three sources as the count), newest first. Deliberately
 * cheap — no cost/vendor enrichment; every link points at /approvals, where the
 * action is taken.
 */
export async function loadApprovalNotifications(role: SdRole): Promise<ApprovalNotification[]> {
  const supabase = await client();
  // Cost rows live outside the status ladder — proposed / rate_submitted are the
  // admin's turn in the negotiation, so they only surface for admins.
  const costTurn = (t: string) =>
    role === 'admin'
      ? supabase
          .from(t)
          .select('id, product_code, status, neg_stage, updated_at')
          .in('neg_stage', ['proposed', 'rate_submitted'])
      : Promise.resolve({ data: [] as never[] });
  const [plans, discontinues, pos, fgCosts, matCosts] = await Promise.all([
    supabase
      .from('sd_buying_plan')
      .select('id, plan_month, plan_type, status, submitted_by, submitted_at')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('id, product_code, product_variant, status, requested_by, requested_at')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_po_approval')
      .select('id, po_ref_num, product_code, category, status, created_by, submitted_for_approval_at')
      .in('status', ['submitted', 'pending_l2']),
    costTurn('sd_standard_cost'),
    costTurn('sd_material_standard_cost'),
  ]);

  const items: ApprovalNotification[] = [];

  for (const p of (plans.data ?? []) as Array<{
    id: number; plan_month: string; plan_type: string | null; status: SdStatus;
    submitted_by: string | null; submitted_at: string | null;
  }>) {
    if (!canApprove(role, p.status)) continue;
    const material = p.plan_type === 'material';
    items.push({
      key: `bp-${p.id}`,
      kind: 'buying_plan',
      label: `${material ? 'Material' : 'FG'} buying plan — ${p.plan_month.slice(0, 7)}`,
      sublabel: 'Buying plan awaiting your approval',
      status: p.status,
      href: '/approvals',
      submittedBy: p.submitted_by,
      submittedAt: p.submitted_at,
    });
  }

  for (const d of (discontinues.data ?? []) as Array<{
    id: number; product_code: string | null; product_variant: string | null; status: SdStatus;
    requested_by: string | null; requested_at: string | null;
  }>) {
    if (!canApprove(role, d.status)) continue;
    items.push({
      key: `dc-${d.id}`,
      kind: 'discontinue',
      label: `Discontinue — ${d.product_code ?? '—'}${d.product_variant ? ` / ${d.product_variant}` : ''}`,
      sublabel: 'Discontinuation awaiting your approval',
      status: d.status,
      href: '/approvals',
      submittedBy: d.requested_by,
      submittedAt: d.requested_at,
    });
  }

  for (const po of (pos.data ?? []) as Array<{
    id: number; po_ref_num: string | null; product_code: string | null; category: string | null;
    status: SdStatus; created_by: string | null; submitted_for_approval_at: string | null;
  }>) {
    if (!canApprove(role, po.status)) continue;
    items.push({
      key: `po-${po.id}`,
      kind: 'po_approval',
      label: `PO — ${po.po_ref_num || po.product_code || `#${po.id}`}`,
      sublabel: `${(po.category ?? 'PO').toUpperCase()} purchase order awaiting your approval`,
      status: po.status,
      href: '/approvals',
      submittedBy: po.created_by,
      submittedAt: po.submitted_for_approval_at,
    });
  }

  type CostNotifRow = { id: number; product_code: string; status: SdStatus; neg_stage: string; updated_at: string | null };
  const costItems = (rows: CostNotifRow[] | null | undefined, material: boolean) => {
    for (const c of (rows ?? []) as CostNotifRow[]) {
      items.push({
        key: `${material ? 'mc' : 'sc'}-${c.id}`,
        kind: 'standard_cost',
        label: `${material ? 'Material' : 'Standard'} cost — ${c.product_code}`,
        sublabel:
          c.neg_stage === 'proposed'
            ? 'Cost proposed — accept, reject or set a target'
            : 'Actual rate submitted — awaiting your sign-off',
        status: c.status,
        href: material
          ? '/standard-cost?track=material'
          : `/standard-cost?open=${encodeURIComponent(c.product_code)}`,
        submittedBy: null,
        submittedAt: c.updated_at,
      });
    }
  };
  costItems(fgCosts.data as CostNotifRow[] | null, false);
  costItems(matCosts.data as CostNotifRow[] | null, true);

  // Newest first; items with no submission timestamp sink to the bottom.
  return items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
}

/* ------------------------------------------------------------------ */
/* My Dashboard — own-scope pipeline + approvals awaiting me           */
/* ------------------------------------------------------------------ */

/**
 * Everything the signed-in user personally needs to act on:
 *   • submissions — buying plans they submitted that are still in flight
 *     (submitted / pending_l2 / rework / rejected), newest first;
 *   • rework — the subset bounced back to them, surfaced as the persistent
 *     (un-dismissable) Rework notice with the approver's remark inline;
 *   • approvals — items from the shared queue this user is allowed to sign off,
 *     so approvers see their own to-do without visiting /approvals.
 */
export async function loadMyDashboard(
  email: string,
  role: SdRole,
): Promise<MyDashboardData> {
  const supabase = await client();

  const { data: plans } = await supabase
    .from('sd_buying_plan')
    .select(
      'id, plan_month, plan_type, status, submitted_by, submitted_at, rework_notes, reworked_by, reworked_at',
    )
    .eq('submitted_by', email)
    .in('status', ['submitted', 'pending_l2', 'rework', 'rejected'])
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .limit(PAGE_SIZE);

  const submissions: MySubmission[] = (
    (plans ?? []) as Array<
      Pick<BuyingPlan, 'id' | 'plan_month' | 'plan_type' | 'status' | 'submitted_at'> & {
        rework_notes: string | null;
        reworked_by: string | null;
        reworked_at: string | null;
      }
    >
  ).map((p) => {
    const track = p.plan_type === 'material' ? 'material' : 'fg';
    return {
      entityType: 'buying_plan' as const,
      entityId: String(p.id),
      track,
      label: `${track === 'material' ? 'Material' : 'FG'} buying plan — ${p.plan_month.slice(0, 7)}`,
      planMonth: p.plan_month,
      status: p.status,
      submittedAt: p.submitted_at,
      reworkNotes: p.rework_notes,
      reworkedBy: p.reworked_by,
      reworkedAt: p.reworked_at,
      href: `/buying-plan?month=${p.plan_month}${track === 'material' ? '&track=material' : ''}`,
    };
  });

  const rework = submissions.filter((s) => s.status === 'rework');

  // Approvals awaiting this user: reuse the shared queue, keep only what this
  // role can act on right now (team → submitted, admin → +pending_l2).
  const { items } = await loadApprovalQueue();
  const approvals = items.filter((i) => canApprove(role, i.status));

  return { submissions, rework, approvals };
}

/* ------------------------------------------------------------------ */
/* Approvals queue                                                     */
/* ------------------------------------------------------------------ */

export async function loadApprovalQueue(): Promise<{
  items: ApprovalQueueItem[];
  log: ApprovalLogRow[];
}> {
  const supabase = await client();

  // Cost negotiation runs outside the status ladder (neg_stage), but the admin's
  // turns — a fresh proposal (proposed) and an actual rate awaiting sign-off
  // (rate_submitted) — surface here too, as link-outs to /standard-cost.
  const [
    { data: plans },
    { data: discontinues },
    { data: pos },
    { data: fgCostReqs },
    { data: log },
  ] = await Promise.all([
    supabase.from('sd_buying_plan').select('*').in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase.from('sd_po_approval').select('*').in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_standard_cost')
      .select('id, product_code, neg_stage, job_cost, fob_cost, efob_cost, proposed_cost, updated_at')
      .in('neg_stage', ['proposed', 'rate_submitted']),
    supabase
      .from('sd_approval_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
  ]);

  const items: ApprovalQueueItem[] = [];

  // Per-line value on the approvals cards uses the same approved standard costs
  // the buying-plan grid values with (per-PO-type rate × its quantity). Material
  // plans value against the approved MATERIAL standard cost (job / purchase),
  // not the FG standard cost — loaded only when a material plan is in the queue.
  const anyMaterial = (plans ?? []).some((p) => (p as BuyingPlan).plan_type === 'material');
  const stdCosts: Record<string, { job: number; fob: number; efob: number }> =
    (plans ?? []).length ? await loadApprovedStandardCosts() : {};
  const matCosts: Record<string, { job: number; fob: number }> = anyMaterial
    ? await loadApprovedMaterialCosts()
    : {};
  const MATERIAL_GROUP: Record<string, string> = {
    raw: 'Raw material',
    dyed: 'Dyed / finished',
    trim: 'Trims',
  };

  // Weave on approval lines is sourced from the product master (live), not the
  // line's stored fabric_type snapshot — one weave source across the project.
  const weaveByCode: Record<string, string> = {};
  if ((plans ?? []).length) {
    const { data: wv } = await supabase
      .from('sd_ee_product_code_status')
      .select('product_code, fabric_type');
    ((wv ?? []) as { product_code: string | null; fabric_type: string | null }[]).forEach((r) => {
      if (r.product_code && r.fabric_type) weaveByCode[r.product_code] = r.fabric_type;
    });
  }

  for (const plan of (plans ?? []) as BuyingPlan[]) {
    const isMaterial = plan.plan_type === 'material';
    const { data: lines } = await supabase
      .from('sd_buying_plan_line')
      .select('id, product_code, fabric_type, material_type, line_status, job_work_qty, fob_qty, efob_qty')
      .eq('plan_id', plan.id);
    const lineRows = (lines ?? []) as (BuyingPlanLine & { material_type: string | null })[];
    const qty = lineRows.reduce(
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
      track: isMaterial ? 'material' : 'fg',
      label: `${isMaterial ? 'Material buying plan' : 'Buying plan'} — ${plan.plan_month.slice(0, 7)}`,
      sublabel: `${lineRows.length} ${isMaterial ? 'material codes' : 'product codes'} · ${qty.toLocaleString('en-IN')} pcs`,
      status: plan.status,
      quantity: qty,
      requiredRole: routeApproval('buying_plan', qty),
      submittedBy: plan.submitted_by,
      submittedAt: plan.submitted_at,
      href: `/buying-plan?month=${plan.plan_month}${isMaterial ? '&track=material' : ''}`,
      lines: lineRows.map((l) => {
        const job = Number(l.job_work_qty || 0);
        const fob = Number(l.fob_qty || 0);
        const efob = Number(l.efob_qty || 0);
        const lineQty = job + fob + efob;
        // Material lines value against the material standard cost (job / purchase,
        // no EFOB) and group by material type; FG lines value against the FG
        // standard cost and group by live weave.
        let value: number;
        let fabricType: string | null;
        if (isMaterial) {
          const cost = matCosts[l.product_code ?? ''];
          value = cost ? job * cost.job + fob * cost.fob : 0;
          fabricType = MATERIAL_GROUP[l.material_type ?? ''] ?? 'Material';
        } else {
          const cost = stdCosts[l.product_code ?? ''];
          value = cost ? job * cost.job + fob * cost.fob + efob * cost.efob : 0;
          fabricType = (l.product_code ? weaveByCode[l.product_code] : undefined) ?? l.fabric_type ?? null;
        }
        return {
          id: String(l.id),
          label: `${l.product_code ?? '—'} · ${lineQty.toLocaleString('en-IN')} pcs`,
          qty: lineQty,
          value,
          fabricType,
          lineStatus: (l.line_status ?? null) as SdStatus | null,
        };
      }),
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

  // Standard-cost negotiation items awaiting the admin. Actioned on /standard-cost
  // (accept / reject / set target / sign off) — surfaced here as a link-out. Status
  // is set to pending_l2 so the shared "awaiting me" (admin) filter picks them up.
  for (const c of (fgCostReqs ?? []) as {
    id: number; product_code: string; neg_stage: string;
    job_cost: number | null; fob_cost: number | null; efob_cost: number | null;
    proposed_cost: number | null; updated_at: string | null;
  }[]) {
    const rates = [
      c.job_cost != null ? `Job ${c.job_cost}` : null,
      c.fob_cost != null ? `FOB ${c.fob_cost}` : null,
      c.efob_cost != null ? `E-FOB ${c.efob_cost}` : null,
      c.proposed_cost != null ? `expected ${c.proposed_cost}` : null,
    ].filter(Boolean).join(' · ');
    const proposed = c.neg_stage === 'proposed';
    items.push({
      entityType: 'standard_cost',
      entityId: String(c.id),
      label: `Standard cost — ${c.product_code}`,
      sublabel:
        (proposed ? 'Rate proposed — accept, reject or set a target' : 'Actual rate submitted — sign off') +
        (rates ? ` · ${rates}` : ''),
      status: 'pending_l2', // cost always needs admin (routeApproval)
      quantity: 0,
      requiredRole: 'admin',
      submittedBy: null,
      submittedAt: c.updated_at,
      href: `/standard-cost?open=${encodeURIComponent(c.product_code)}`,
    });
  }

  if ((pos ?? []).length) {
    const poList = (pos ?? []) as PoApproval[];
    const [inProcessByVendor, latestCapacity, stdCosts] = await Promise.all([
      loadInProcessByVendor(),
      loadLatestVendorCapacity(),
      loadApprovedStandardCosts(),
    ]);
    // Product-level inventory snapshot (DOQ / stock / days) for the PO products.
    const poCodes = [...new Set(poList.map((p) => p.product_code).filter(Boolean))] as string[];
    const invByProduct: Record<string, { stock: number; inProgress: number; daily: number; doq45: number }> = {};
    if (poCodes.length) {
      const { data: inv } = await supabase
        .from('sd_inventory_by_product')
        .select('product_code, current_stock, total_inprogress, daily_quantity, doq_45')
        .in('product_code', poCodes);
      for (const r of (inv ?? []) as Record<string, unknown>[]) {
        invByProduct[String(r.product_code)] = {
          stock: Number(r.current_stock) || 0,
          inProgress: Number(r.total_inprogress) || 0,
          daily: Number(r.daily_quantity) || 0,
          doq45: Number(r.doq_45) || 0,
        };
      }
    }

    // Standard CM (CMTP total) + standard finished-fabric per product — the
    // benchmarks the PO cost-pivot compares against (spec §5). CM gates approval;
    // finished fabric is shown for awareness only.
    const stdCmByCode: Record<string, number> = {};
    const stdFabricByCode: Record<string, number> = {};
    if (poCodes.length) {
      const { data: scRows } = await supabase
        .from('sd_standard_cost')
        .select('product_code, cm_cost, fabric_code')
        .in('product_code', poCodes);
      const fabricCodes = [
        ...new Set(
          ((scRows ?? []) as { fabric_code: string | null }[])
            .map((r) => r.fabric_code)
            .filter(Boolean) as string[],
        ),
      ];
      const fabricRate: Record<string, number> = {};
      if (fabricCodes.length) {
        const { data: fb } = await supabase
          .from('sd_fabric_cost_base')
          .select('fabric_code, finished_fabric_cost')
          .in('fabric_code', fabricCodes);
        for (const r of (fb ?? []) as { fabric_code: string; finished_fabric_cost: number | null }[]) {
          if (r.finished_fabric_cost != null) fabricRate[r.fabric_code] = Number(r.finished_fabric_cost);
        }
      }
      for (const r of (scRows ?? []) as {
        product_code: string;
        cm_cost: number | null;
        fabric_code: string | null;
      }[]) {
        if (r.cm_cost != null) stdCmByCode[r.product_code] = Number(r.cm_cost);
        if (r.fabric_code && fabricRate[r.fabric_code] != null) {
          stdFabricByCode[r.product_code] = fabricRate[r.fabric_code];
        }
      }
    }

    for (const po of poList) {
      const qty = Number(po.po_qty || 0);
      const vendor = (po.vendor_code ?? '').trim();
      const { data: poLines } = await supabase
        .from('sd_po_approval_line')
        .select('id, product_variant, size, qty')
        .eq('po_id', po.id);
      const cap = vendor ? latestCapacity.get(vendor.toLowerCase()) : undefined;
      const stdCost = po.product_code ? stdCosts[po.product_code] ?? null : null;
      const inv = po.product_code ? invByProduct[po.product_code] ?? null : null;
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
        lines: ((poLines ?? []) as { id: number; product_variant: string | null; size: string | null; qty: number | null }[]).map((l) => ({
          id: String(l.id),
          label: `${l.product_variant ?? '—'}${l.size ? ' / ' + l.size : ''} · ${Number(l.qty || 0).toLocaleString('en-IN')} pcs`,
        })),
        poDetail: {
          productCode: po.product_code,
          poType: po.po_type,
          poQty: qty,
          writtenRate: po.rate,
          stdCost,
          poCm: po.cm_cost,
          stdCm: po.product_code ? stdCmByCode[po.product_code] ?? null : null,
          poGrey: po.grey_cost,
          poFinishedFabric: po.finished_fabric_cost,
          stdFinishedFabric: po.product_code ? stdFabricByCode[po.product_code] ?? null : null,
          marginPct: po.margin_pct,
          inventory: inv
            ? {
                currentStock: inv.stock,
                inProgress: inv.inProgress,
                dailyQty: inv.daily,
                doq45: inv.doq45,
                daysOfStock: inv.daily > 0 ? Math.round(inv.stock / inv.daily) : null,
              }
            : null,
          tna: {
            poClosingDate: po.po_closing_date,
            ppSampleDue: po.cs_pp_sample_due,
            gptDue: po.cs_gpt_due,
            cuttingStart: po.cs_cutting_start,
            inlineQcDue: po.cs_inline_qc_due,
            firstDelivery: po.critical_path_first_delivery,
            requestedTotalDays: po.requested_total_days,
            tnaConfirmed: po.tna_confirmed,
          },
        },
      });
    }
  }

  const { count: recCount } = await supabase
    .from('sd_receivable_input')
    .select('row_key', { count: 'exact', head: true })
    .eq('status', 'submitted');
  if (recCount) {
    items.push({
      entityType: 'receivable_plan',
      entityId: 'batch',
      label: `Receivable plan — ${recCount} row(s)`,
      sublabel: 'Weekly receiving inputs submitted for approval',
      status: 'submitted',
      quantity: recCount,
      requiredRole: routeApproval('receivable_plan'),
      submittedBy: null,
      submittedAt: null,
      href: '/receivable-plan',
    });
  }
  items.sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
  return { items, log: (log ?? []) as ApprovalLogRow[] };
}

/** Exact, all-time %-of-approvals-that-needed-edits across the record entities. */
export async function loadApprovalStats(): Promise<{ approved: number; edited: number; pct: number }> {
  const supabase = await client();
  const tables = ['sd_buying_plan', 'sd_po_approval', 'sd_standard_cost', 'sd_discontinue_request'];
  const counts = await Promise.all(
    tables.flatMap((t) => [
      supabase.from(t).select('id', { count: 'exact', head: true }).eq('status', 'approved'),
      supabase
        .from(t)
        .select('id', { count: 'exact', head: true })
        .eq('status', 'approved')
        .eq('edited_before_approval', true),
    ]),
  );
  let approved = 0;
  let edited = 0;
  for (let i = 0; i < counts.length; i += 2) {
    approved += counts[i].count ?? 0;
    edited += counts[i + 1].count ?? 0;
  }
  return { approved, edited, pct: approved ? Math.round((edited / approved) * 100) : 0 };
}
