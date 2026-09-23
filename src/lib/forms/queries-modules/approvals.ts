import 'server-only';
import { client, PAGE_SIZE } from './_shared';
import {
  approversFor,
  canApprove,
  isEscalated,
  levelForStatus,
  routeApproval,
  STATUS_LABEL,
  type ApprovalLevel,
  type ApprovalMatrix,
} from '../approval';
import { loadApprovedStandardCosts, loadApprovedMaterialCosts } from './standard-cost';
import { loadInProcessByVendor, loadLatestVendorCapacity } from './vendor';
import { loadAnalyticsRules } from './analytics';
import { capacityRulesFrom, vendorCapacityModel } from '@/lib/business-logic';
import { DEBOARDING_REASON_LABEL, DEBOARDING_SCORES } from '../deboarding';
import type {
  ApprovalMatrixMember,
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
  PoDeleteRequest,
  VendorDeboardingRequest,
} from '../types';

/**
 * Spec 7.5 — who sits at L1 / L2 / L3, in order (primary first, then the fallbacks).
 * An empty level means "not configured", and the role ladder decides instead.
 */
export async function loadApprovalMatrix(): Promise<ApprovalMatrix> {
  const supabase = await client();
  // paging-ok: a handful of named approvers per level, by design
  const { data } = await supabase
    .from('sd_approval_matrix')
    .select('level, email, position, active')
    .eq('active', true)
    .order('level')
    .order('position')
    .limit(100);
  const matrix: ApprovalMatrix = { l1: [], l2: [], l3: [] };
  for (const r of (data ?? []) as { level: ApprovalLevel; email: string }[]) {
    if (matrix[r.level]) matrix[r.level].push(r.email);
  }
  return matrix;
}

/** The matrix as rows, for the User Panel editor (includes who is switched off). */
export async function loadApprovalMatrixRows(): Promise<ApprovalMatrixMember[]> {
  const supabase = await client();
  // paging-ok: a handful of named approvers per level, by design
  const { data } = await supabase
    .from('sd_approval_matrix')
    .select('id, level, email, position, active')
    .order('level')
    .order('position')
    .limit(100);
  return (data ?? []) as ApprovalMatrixMember[];
}

/** Cheap count of items in the shared approval queue, for the notification bell. */
export async function countPendingApprovals(): Promise<number> {
  const supabase = await client();
  const pending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('status', ['submitted', 'pending_l2']);
  // Cost negotiation runs outside the status ladder: proposed / rate_submitted
  // are the admin's turn (the bell renders for admins only).
  const costPending = (t: string) =>
    supabase.from(t).select('*', { count: 'exact', head: true }).in('neg_stage', ['proposed', 'rate_submitted']);
  const [a, b, c, d, e, f, g] = await Promise.all([
    pending('sd_buying_plan'),
    pending('sd_discontinue_request'),
    pending('sd_po_approval'),
    costPending('sd_standard_cost'),
    costPending('sd_material_standard_cost'),
    pending('sd_vendor_deboarding_request'),
    pending('sd_po_delete_request'),
  ]);
  return (
    (a.count ?? 0) + (b.count ?? 0) + (c.count ?? 0) + (d.count ?? 0) + (e.count ?? 0) +
    (f.count ?? 0) + (g.count ?? 0)
  );
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
  const [plans, discontinues, pos, fgCosts, matCosts, deboardings, poDeletes] = await Promise.all([
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
      .select('id, request_id, po_ref_num, product_code, category, status, created_by, submitted_for_approval_at')
      .in('status', ['submitted', 'pending_l2'])
      .is('deleted_at', null),
    costTurn('sd_standard_cost'),
    costTurn('sd_material_standard_cost'),
    supabase
      .from('sd_vendor_deboarding_request')
      .select('id, vendor_code, vendor_name, status, requested_by, requested_at')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_po_delete_request')
      .select('id, request_id, product_code, reason, status, requested_by, requested_at')
      .in('status', ['submitted', 'pending_l2']),
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

  for (const d of (deboardings.data ?? []) as Array<{
    id: number; vendor_code: string; vendor_name: string | null; status: SdStatus;
    requested_by: string | null; requested_at: string | null;
  }>) {
    if (!canApprove(role, d.status)) continue;
    items.push({
      key: `vd-${d.id}`,
      kind: 'vendor_deboarding',
      label: `De-board vendor — ${d.vendor_code}${d.vendor_name ? ` ${d.vendor_name}` : ''}`,
      sublabel: 'Vendor de-boarding awaiting your approval',
      status: d.status,
      href: '/approvals',
      submittedBy: d.requested_by,
      submittedAt: d.requested_at,
    });
  }

  for (const po of (pos.data ?? []) as Array<{
    id: number; request_id: string | null; po_ref_num: string | null; product_code: string | null; category: string | null;
    status: SdStatus; created_by: string | null; submitted_for_approval_at: string | null;
  }>) {
    if (!canApprove(role, po.status)) continue;
    items.push({
      key: `po-${po.id}`,
      kind: 'po_approval',
      label: `PO request — ${po.request_id || po.po_ref_num || po.product_code || `#${po.id}`}`,
      sublabel: `${(po.category ?? 'PO').toUpperCase()} purchase order awaiting your approval`,
      status: po.status,
      href: '/approvals',
      submittedBy: po.created_by,
      submittedAt: po.submitted_for_approval_at,
    });
  }

  for (const d of (poDeletes.data ?? []) as Array<{
    id: number; request_id: string; product_code: string | null; reason: string;
    status: SdStatus; requested_by: string | null; requested_at: string | null;
  }>) {
    if (!canApprove(role, d.status)) continue;
    items.push({
      key: `pd-${d.id}`,
      kind: 'po_delete',
      label: `Delete PO request — ${d.request_id}${d.product_code ? ` · ${d.product_code}` : ''}`,
      sublabel: `Deletion awaiting your approval — ${d.reason}`,
      status: d.status,
      href: '/approvals',
      submittedBy: d.requested_by,
      submittedAt: d.requested_at,
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
          ? `/standard-cost/${encodeURIComponent(c.product_code)}?track=material`
          : `/standard-cost/${encodeURIComponent(c.product_code)}`,
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
      href: `/buying-plan?month=${p.plan_month}${track === 'material' ? '&type=material' : ''}`,
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
    { data: matCostReqs },
    { data: log },
    { data: deboardings },
    { data: poDeletes },
  ] = await Promise.all([
    supabase.from('sd_buying_plan').select('*').in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_discontinue_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase.from('sd_po_approval').select('*').in('status', ['submitted', 'pending_l2']).is('deleted_at', null),
    supabase
      .from('sd_standard_cost')
      .select('id, product_code, neg_stage, job_cost, fob_cost, efob_cost, proposed_cost, updated_at')
      .eq('hidden', false)
      .in('neg_stage', ['proposed', 'rate_submitted']),
    supabase
      .from('sd_material_standard_cost')
      .select('id, product_code, neg_stage, job_cost, fob_cost, efob_cost, proposed_cost, updated_at')
      .eq('hidden', false)
      .in('neg_stage', ['proposed', 'rate_submitted']),
    supabase
      .from('sd_approval_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('sd_vendor_deboarding_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
    supabase
      .from('sd_po_delete_request')
      .select('*')
      .in('status', ['submitted', 'pending_l2']),
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
      .select('id, product_code, fabric_type, material_type, line_status, job_work_qty, fob_qty, efob_qty, standard_value')
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
      href: `/buying-plan?month=${plan.plan_month}${isMaterial ? '&type=material' : ''}`,
      lines: lineRows.map((l) => {
        const job = Number(l.job_work_qty || 0);
        const fob = Number(l.fob_qty || 0);
        const efob = Number(l.efob_qty || 0);
        const lineQty = job + fob + efob;
        // Material lines value against the material standard cost (job / purchase,
        // no EFOB) and group by material type; FG lines value against the FG
        // standard cost and group by live weave.
        // Value the line the way the submitter saw it: the standard_value frozen at
        // submission wins; the live rate is only a fallback for lines that had no
        // accepted rate to freeze.
        const frozen = Number(l.standard_value ?? 0) || 0;
        let value: number;
        let fabricType: string | null;
        if (isMaterial) {
          const cost = matCosts[l.product_code ?? ''];
          value = frozen > 0 ? frozen : cost ? job * cost.job + fob * cost.fob : 0;
          fabricType = MATERIAL_GROUP[l.material_type ?? ''] ?? 'Material';
        } else {
          const cost = stdCosts[l.product_code ?? ''];
          value = frozen > 0 ? frozen : cost ? job * cost.job + fob * cost.fob + efob * cost.efob : 0;
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

  // De-boarding: the whole case fits on the card — reason, the four ratings, the PO
  // evidence and whether the team thinks it is fixable — with the remarks as the note.
  for (const req of (deboardings ?? []) as VendorDeboardingRequest[]) {
    const late = req.pos_late_15d + req.pos_late_1m + req.pos_late_over_1m;
    const reason =
      (DEBOARDING_REASON_LABEL[req.reason] ?? req.reason) +
      (req.reason === 'other' && req.reason_other ? ` — ${req.reason_other}` : '');
    const ratings = DEBOARDING_SCORES.map((s) => `${s.short} ${req[s.key]}/5`).join(' · ');
    items.push({
      entityType: 'vendor_deboarding',
      entityId: String(req.id),
      label: `De-board vendor — ${req.vendor_code}${req.vendor_name ? ` ${req.vendor_name}` : ''}`,
      sublabel: `${reason} · ${ratings} · ${req.pos_done} POs done, ${late} late${
        req.rejection_pct != null ? `, ${Number(req.rejection_pct)}% rejected at GRN` : ''
      } · ${req.resolvable ? 'team says resolvable' : 'team says not resolvable'}`,
      status: req.status,
      quantity: 0,
      requiredRole: routeApproval('vendor_deboarding'),
      submittedBy: req.requested_by,
      submittedAt: req.requested_at,
      submitNote: req.remarks,
      href: '/vendor-deboarding',
    });
  }

  // Deleting a raised PO request is its own approval: what is being deleted, what state it
  // was in when the ask went up, who raised the PO, and the reason given for pulling it.
  // Approving this card is what marks the PO deleted (see applyPoDeletion).
  for (const req of (poDeletes ?? []) as PoDeleteRequest[]) {
    items.push({
      entityType: 'po_delete',
      entityId: String(req.id),
      label: `Delete PO request ${req.request_id}${req.product_code ? ` · ${req.product_code}` : ''}`,
      sublabel: `${STATUS_LABEL[req.po_status]} · ${req.vendor_name || req.vendor_code || 'no vendor'} · ${Number(
        req.po_qty || 0,
      ).toLocaleString('en-IN')} pcs — approving this removes it from the working lists`,
      status: req.status,
      quantity: Number(req.po_qty || 0),
      requiredRole: routeApproval('po_delete'),
      submittedBy: req.requested_by,
      submittedAt: req.requested_at,
      submitNote: `Reason for deleting: ${req.reason}`,
      href: '/po-approval',
    });
  }

  // Standard-cost negotiation items awaiting the admin. Actioned on /standard-cost
  // (accept / reject / set target / sign off) — surfaced here as a link-out. Status
  // is set to pending_l2 so the shared "awaiting me" (admin) filter picks them up.
  type CostReq = {
    id: number; product_code: string; neg_stage: string;
    job_cost: number | null; fob_cost: number | null; efob_cost: number | null;
    proposed_cost: number | null; updated_at: string | null;
  };
  // Both tracks: FG rates read Job / FOB / E-FOB; material rates read FOB Fabric /
  // Billing / Standard Fabric (same columns, different meaning).
  const pushCostItems = (rows: CostReq[] | null | undefined, material: boolean) => {
    for (const c of (rows ?? []) as CostReq[]) {
      const rates = [
        c.job_cost != null ? `${material ? 'FOB Fabric' : 'Job'} ${c.job_cost}` : null,
        c.fob_cost != null ? `${material ? 'Billing' : 'FOB'} ${c.fob_cost}` : null,
        c.efob_cost != null ? `${material ? 'Standard Fabric' : 'E-FOB'} ${c.efob_cost}` : null,
        c.proposed_cost != null ? `expected ${c.proposed_cost}` : null,
      ].filter(Boolean).join(' · ');
      const proposed = c.neg_stage === 'proposed';
      items.push({
        entityType: 'standard_cost',
        entityId: `${material ? 'm' : 'f'}${c.id}`,
        label: `${material ? 'Material' : 'Standard'} cost — ${c.product_code}`,
        sublabel:
          (proposed ? 'Rate proposed — accept, reject or set a target' : 'Actual rate submitted — sign off') +
          (rates ? ` · ${rates}` : ''),
        status: 'pending_l2', // cost always needs admin (routeApproval)
        quantity: 0,
        requiredRole: 'admin',
        submittedBy: null,
        submittedAt: c.updated_at,
        href: `/standard-cost?${material ? 'track=material&' : ''}open=${encodeURIComponent(c.product_code)}`,
      });
    }
  };
  pushCostItems(fgCostReqs as CostReq[] | null, false);
  pushCostItems(matCostReqs as CostReq[] | null, true);

  if ((pos ?? []).length) {
    const poList = (pos ?? []) as PoApproval[];
    const [inProcessByVendor, latestCapacity, stdCosts, analyticsRules] = await Promise.all([
      loadInProcessByVendor(),
      loadLatestVendorCapacity(),
      loadApprovedStandardCosts(),
      loadAnalyticsRules(),
    ]);
    const capacityRules = capacityRulesFrom(analyticsRules);
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
      // The one capacity model, for THIS PO's type: an E-FOB PO is judged against what the
      // vendor can make in 45 days, a FOB PO against 75 — not against one month.
      const capModel = cap
        ? vendorCapacityModel(
            {
              machines: cap.machines,
              karigar: cap.karigar,
              vendorType: po.po_type ?? po.category,
              inProcessQty: vendor ? inProcessByVendor.get(vendor.toLowerCase()) ?? 0 : 0,
            },
            capacityRules,
          )
        : null;
      const stdCost = po.product_code ? stdCosts[po.product_code] ?? null : null;
      // Pending pieces per SKU for this PO's product, for the SKU-level line labels.
      const pendingBySku = new Map<string, number>();
      if (po.product_code) {
        const { data: openForProduct } = await supabase
          .from('sd_po_dashboard')
          .select('sku, pending_qty')
          .eq('product_code', po.product_code)
          .gt('pending_qty', 0)
          .limit(500); // paging-ok: one product's open lines, a few dozen at most
        for (const r of (openForProduct ?? []) as { sku: string | null; pending_qty: number | null }[]) {
          const sku = (r.sku ?? '').trim().toUpperCase();
          if (!sku) continue;
          pendingBySku.set(sku, (pendingBySku.get(sku) ?? 0) + (Number(r.pending_qty) || 0));
        }
      }
      const inv = po.product_code ? invByProduct[po.product_code] ?? null : null;
      items.push({
        entityType: 'po_approval',
        entityId: String(po.id),
        label: `PO request ${po.request_id ?? `#${po.id}`}${po.po_ref_num ? ` · ${po.po_ref_num}` : ''} — ${po.category.toUpperCase()}`,
        sublabel: `${po.product_code ?? '—'} · ${po.vendor_name || vendor || '—'} · ${qty.toLocaleString('en-IN')} pcs`,
        status: po.status,
        quantity: qty,
        requiredRole: routeApproval('po_approval', qty, po.category),
        submittedBy: po.created_by,
        submittedAt: po.submitted_for_approval_at,
        href: '/po-approval',
        // Spec item 6 — plan relationship is shown to the approver, never enforced.
        submitNote:
          [
            po.in_buying_plan === true
              ? `In the ${(po.buying_plan_no && /^\d{4}-\d{2}$/.test(po.buying_plan_no) ? po.buying_plan_no : 'current')} buying plan${po.plan_qty_at_submit ? ` — approved ${Number(po.plan_qty_at_submit).toLocaleString('en-IN')} pcs` : ''}`
              : po.in_buying_plan === false
                ? `Ad-hoc purchase — outside the ${(po.buying_plan_no && /^\d{4}-\d{2}$/.test(po.buying_plan_no) ? po.buying_plan_no : 'current')} buying plan${po.ad_hoc_reason ? `: ${po.ad_hoc_reason}` : ' (no reason given)'}`
                : undefined,
            po.submit_remark ? `Remark: ${po.submit_remark}` : null,
          ]
            .filter(Boolean)
            .join(' · ') || undefined,
        vendorCode: vendor || null,
        vendorInProcessQty: vendor
          ? inProcessByVendor.get(vendor.toLowerCase()) ?? null
          : null,
        vendorCapacityPerMonth: capModel?.entered ? capModel.capacityPerMonth : null,
        vendorPoCapacity: capModel?.entered ? capModel.poCapacity : null,
        vendorCapacityUtil: capModel?.capacityUtil ?? null,
        vendorLeadDays: capModel?.leadDays ?? null,
        vendorCapacityUpdatedAt: cap?.weekOf ?? null,
        // Spec 7.2 — the approver sees the PO at SKU level, with what is already pending for
        // that SKU beside it (same comparison the person entering the quantities saw).
        lines: ((poLines ?? []) as { id: number; product_variant: string | null; size: string | null; qty: number | null }[]).map((l) => {
          const variant = (l.product_variant ?? '').trim().toUpperCase();
          const size = (l.size ?? '').trim().toUpperCase();
          const sku = size ? `${variant}_${size}` : variant;
          const qty = Number(l.qty || 0);
          const pendingForSku = pendingBySku.get(sku) ?? 0;
          return {
            id: String(l.id),
            label: `${sku || '—'} · ${qty.toLocaleString('en-IN')} pcs${
              pendingForSku ? ` · ${pendingForSku.toLocaleString('en-IN')} already pending` : ''
            }`,
            qty,
          };
        }),
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

  const { data: recRows, count: recCount } = await supabase
    .from('sd_receivable_input')
    .select('submitted_by, submitted_at, submit_notes', { count: 'exact' })
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false });
  if (recCount) {
    const latest = (recRows ?? [])[0] as
      | { submitted_by: string | null; submitted_at: string | null; submit_notes: string | null }
      | undefined;
    // Most recent non-empty submit remark across the submitted batch.
    const note =
      ((recRows ?? []) as { submit_notes: string | null }[]).find((r) => (r.submit_notes ?? '').trim())
        ?.submit_notes ?? null;
    items.push({
      entityType: 'receivable_plan',
      entityId: 'batch',
      label: `Receivable plan — ${recCount} row(s)`,
      sublabel: 'Weekly receiving inputs submitted for approval',
      status: 'submitted',
      quantity: recCount,
      requiredRole: routeApproval('receivable_plan'),
      submittedBy: latest?.submitted_by ?? null,
      submittedAt: latest?.submitted_at ?? null,
      submitNote: note,
      href: '/receivable-plan',
    });
  }
  // Spec 7.5 — stamp each card with whose turn it is and how long it has been theirs, so
  // the queue says who is holding it up rather than leaving everyone to assume.
  const [matrix, rules] = await Promise.all([loadApprovalMatrix(), loadAnalyticsRules()]);
  const escalationDays = Number(rules.approval_escalation_days ?? 0);
  const now = Date.now();
  for (const item of items) {
    item.level = levelForStatus(item.status);
    item.approvers = approversFor(item.status, matrix);
    item.daysWaiting = item.submittedAt
      ? Math.max(0, Math.floor((now - Date.parse(item.submittedAt)) / 86_400_000))
      : null;
    item.escalated = isEscalated(item.submittedAt, escalationDays);
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
