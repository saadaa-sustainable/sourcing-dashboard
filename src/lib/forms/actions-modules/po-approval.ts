'use server';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance } from '@/lib/business-logic';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts } from '../queries';
import { canApprove, canEdit, canSubmit, statusOnSubmit } from '../approval';
import {
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canPropose,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  canSubmitRate,
} from '../cost';
import type { ApprovalEntity, PoCategory, PoType, SdRole, SdStatus } from '../types';
import { INWARD_PLAN_STATUSES } from '../types';
import {
  type ActionResult,
  type LinkResult,
  fail,
  done,
  supa,
  writeLog,
  recordCommitment,
  numOrNull,
  dateOrNull,
  textOrNull,
} from './_shared';

const PO_TYPES: PoType[] = ['FOB', 'job_work', 'efob'];
const PO_CATEGORIES: PoCategory[] = ['fg', 'mat', 'npd'];
function readPoFields(formData: FormData) {
  const rawType = String(formData.get('po_type') ?? '');
  const rawCat = String(formData.get('category') ?? 'fg').toLowerCase();
  return {
    po_type: (PO_TYPES.includes(rawType as PoType) ? rawType : null) as PoType | null,
    product_code: textOrNull(formData.get('product_code')),
    po_ref_num: textOrNull(formData.get('po_ref_num')),
    vendor_code: textOrNull(formData.get('vendor_code')),
    vendor_name: textOrNull(formData.get('vendor_name')),
    tna_sheet_url: textOrNull(formData.get('tna_sheet_url')),
    cost_sheet_url: textOrNull(formData.get('cost_sheet_url')),
    rate: numOrNull(formData.get('rate')),
    // Per-PO cost pivot (spec §5) — commodity params + the gated CM figure.
    grey_cost: numOrNull(formData.get('grey_cost')),
    finished_fabric_cost: numOrNull(formData.get('finished_fabric_cost')),
    cm_cost: numOrNull(formData.get('cm_cost')),
    margin_pct: numOrNull(formData.get('margin_pct')),
    // po_qty is NOT taken from the form — it is derived from the size lines
    // (savePoLines keeps sd_po_approval.po_qty = sum of line qty).
    po_closing_date: dateOrNull(formData.get('po_closing_date')),
    cad_folder_url: textOrNull(formData.get('cad_folder_url')),
    cs_pp_sample_due: dateOrNull(formData.get('cs_pp_sample_due')),
    cs_gpt_due: dateOrNull(formData.get('cs_gpt_due')),
    cs_cutting_start: dateOrNull(formData.get('cs_cutting_start')),
    cs_inline_qc_due: dateOrNull(formData.get('cs_inline_qc_due')),
    critical_path_first_delivery: dateOrNull(formData.get('critical_path_first_delivery')),
    buying_plan_no: textOrNull(formData.get('buying_plan_no')),
    category: (PO_CATEGORIES.includes(rawCat as PoCategory) ? rawCat : 'fg') as PoCategory,
  };
}

export async function savePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id')) || 0;
  const supabase = await supa();

  // Guard edits against the current stored status.
  let status: SdStatus = 'draft';
  if (id) {
    const { data: existing } = await supabase
      .from('sd_po_approval')
      .select('id, status')
      .eq('id', id)
      .maybeSingle();
    if (!existing) return fail('PO not found.');
    status = existing.status as SdStatus;
  }
  if (!canEdit(user.role, status)) {
    return fail(
      status === 'approved'
        ? 'This PO is approved and can no longer be edited.'
        : 'You do not have permission to edit PO approvals.',
    );
  }

  const fields = readPoFields(formData);

  if (id) {
    const { error } = await supabase
      .from('sd_po_approval')
      .update(fields)
      .eq('id', id)
      .in('status', ['draft', 'rework']);
    if (error) return fail(`Could not save: ${error.message}`);
    revalidatePath('/po-approval');
    return { ok: true, message: 'Saved.', id };
  }

  const { data, error } = await supabase
    .from('sd_po_approval')
    .insert({ ...fields, created_by: user.email, status: 'draft' })
    .select('id')
    .single();
  if (error) return fail(`Could not create PO: ${error.message}`);
  revalidatePath('/po-approval');
  return { ok: true, message: `Saved PO #${data.id}.`, id: data.id as number };
}

/**
 * Item 1 — sequencing gate. Returns a failing ActionResult if the reverse-sequencing
 * rule is ON and no APPROVED Standard Cost exists for the product; returns null to
 * pass. Read straight from sd_analytics_rule (default 0/off) so it never touches the
 * held queries.ts rule map. Material POs check sd_material_standard_cost; FG/NPD
 * check sd_standard_cost. A frozen cost was necessarily approved, so it also passes.
 */
async function assertApprovedStandardCost(
  supabase: Awaited<ReturnType<typeof supa>>,
  category: string,
  productCode: string | null,
): Promise<ActionResult | null> {
  const { data: rule } = await supabase
    .from('sd_analytics_rule')
    .select('value')
    .eq('rule_key', 'enforce_standard_cost_before_po')
    .maybeSingle();
  const enforce = Number(rule?.value ?? 0) >= 1;
  if (!enforce) return null;

  const code = (productCode ?? '').trim();
  if (!code) {
    return fail('Set the product before submitting — an approved Standard Cost is required first.');
  }
  const isMaterial = category === 'mat';
  const table = isMaterial ? 'sd_material_standard_cost' : 'sd_standard_cost';
  const { data: sc } = await supabase
    .from(table)
    .select('status, frozen')
    .eq('product_code', code)
    .maybeSingle();
  const approved = sc?.status === 'approved' || sc?.frozen === true;
  if (!approved) {
    const where = isMaterial ? 'Material Standard Cost' : 'Standard Cost';
    return fail(
      `No approved ${where} exists for ${code}. Propose and get the cost approved (freeze it) first — the PO issues against that approved cost, not a number typed here.`,
    );
  }
  return null;
}

export async function submitPoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the PO before submitting it.');

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, po_ref_num, category, product_code, po_qty, rate, critical_path_first_delivery')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (!canSubmit(user.role, po.status as SdStatus)) {
    return fail('This PO cannot be submitted from its current state.');
  }
  const qty = Number(po.po_qty || 0);
  if (qty <= 0) return fail('Add the size lines — PO quantity is the sum of those.');
  if (po.rate == null) return fail('Fill the rate (alongside the cost sheet) before submitting.');

  // Item 1 — reverse sequencing gate: the Standard Cost must be proposed, reviewed
  // and APPROVED before a PO can be submitted against it (not typed ad hoc here and
  // backfilled afterward). Rules-Master toggle `enforce_standard_cost_before_po`
  // (default 0/off — see migration; PO Approval is live and costs aren't populated
  // yet, so this stays staged until the team turns it on). When on, block unless an
  // approved cost record exists: FG/NPD → sd_standard_cost, Material → sd_material_standard_cost.
  const gateResult = await assertApprovedStandardCost(
    supabase,
    po.category as string,
    po.product_code as string | null,
  );
  if (gateResult) return gateResult;

  const now = new Date();
  // Total days as REQUESTED at submission: requested first-delivery minus today.
  // Locked here so it doesn't drift with the eventual approval date.
  let requestedTotalDays: number | null = null;
  if (po.critical_path_first_delivery) {
    const target = new Date(`${po.critical_path_first_delivery}T00:00:00Z`).getTime();
    const start = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    requestedTotalDays = Math.round((target - start) / 86_400_000);
  }

  const next = statusOnSubmit('po_approval', qty, po.category as string);
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      status: next,
      submitted_for_approval_at: now.toISOString(),
      requested_total_days: requestedTotalDays,
      rejection_notes: null,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  await writeLog(
    'po_approval',
    String(id),
    `PO ${po.po_ref_num ?? `#${id}`} · ${po.category} · ${po.product_code ?? ''}`.trim(),
    'draft',
    next,
    user.email,
  );
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(
    next === 'pending_l2' ? 'Submitted for admin approval.' : 'Submitted for approval.',
  );
}

/**
 * After approval, issue + sign the PO. Captures the EasyCom mapping key (which
 * ties to sd_po_master_raw) plus the DiGiO-signed docs, sign date, and first
 * actual delivery date (fields 19–25). The DiGiO fields are manual URLs for now
 * — the API integration populates them later. Callable repeatedly to add the
 * signed docs after the initial issuance.
 */
export async function issuePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) {
    return fail('You do not have permission to issue POs.');
  }

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid PO.');
  const easycom = String(formData.get('easycom_po_no') ?? '').trim();

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, product_code, po_type, po_ref_num, vendor_code, po_issued_at, critical_path_first_delivery, cm_cost, cm_override_at')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status !== 'approved') return fail('Only an approved PO can be issued.');

  const alreadyIssued = Boolean(po.po_issued_at);
  // The EasyCom number is required to first issue; once issued it can be edited.
  if (!alreadyIssued && !easycom) return fail('Enter the EasyCom PO number to issue.');

  // §7 issuance gate vs the approval log: a PO can't be ISSUED at an above-standard
  // CMTP unless that exception was separately approved (logged). Confirming here with
  // a mandatory remark records it (cm_override_* + sd_approval_log); a PO already
  // carrying a logged exception passes. Validates against the log, not a static number.
  let costException: { poCm: number; stdCm: number } | null = null;
  if (!alreadyIssued && po.cm_cost != null && po.product_code && !po.cm_override_at) {
    const { data: std } = await supabase
      .from('sd_standard_cost')
      .select('cm_cost')
      .eq('product_code', po.product_code)
      .maybeSingle();
    const stdCm = std?.cm_cost == null ? null : Number(std.cm_cost);
    if (stdCm != null && Number(po.cm_cost) > stdCm + 0.005) {
      const override = formData.get('cost_override') === 'true';
      const note = String(formData.get('cost_override_note') ?? '').trim();
      if (!override || !note) {
        return fail(
          `This PO's CMTP ₹${po.cm_cost} is above the standard ₹${stdCm} and was never separately approved. Confirm the above-standard cost with a reason to issue.`,
        );
      }
      costException = { poCm: Number(po.cm_cost), stdCm };
    }
  }

  // §4 live recompute (audit trail): stamp the expected FINAL price computed at
  // the CURRENT fabric rate — the basis a vendor submission is validated against,
  // not the frozen standard. Best-effort: silently skipped if cost inputs are
  // missing (today they mostly are), and never blocks issuance.
  const recomputePatch: Record<string, unknown> = {};
  if (!alreadyIssued && po.product_code) {
    try {
      const [{ data: sc }, { data: lines }] = await Promise.all([
        supabase.from('sd_standard_cost').select('fabric_code, cm_cost').eq('product_code', po.product_code).maybeSingle(),
        supabase.from('sd_standard_cost_line').select('consumption, fabric_cost').eq('product_code', po.product_code),
      ]);
      const cons = (lines ?? []).map((l) => Number(l.consumption)).filter((n) => n > 0);
      const avgCons = cons.length ? cons.reduce((s, n) => s + n, 0) / cons.length : 0;
      const baked = (lines ?? [])
        .map((l) => (Number(l.consumption) > 0 ? Number(l.fabric_cost) / Number(l.consumption) : 0))
        .filter((n) => n > 0);
      const rateAtStd = baked.length ? baked.reduce((s, n) => s + n, 0) / baked.length : null;
      // Resolve the product's fabric: the Standard Cost sheet's fabric first, else the
      // Product Master relation (product → rm_fabric_sku), so it works without manual entry.
      let fabricCode: string | null = sc?.fabric_code ?? null;
      if (!fabricCode) {
        const { data: pf } = await supabase
          .from('sd_product_fabric')
          .select('fabric_code')
          .eq('product_code', po.product_code)
          .maybeSingle();
        fabricCode = (pf?.fabric_code as string | null) ?? null;
      }
      let rateNow: number | null = null;
      if (fabricCode) {
        // An EFOB PO is validated against the EFOB monthly rate the company set for
        // this fabric (carrying the commodity risk), for the current month — falling
        // back to the fabric's finished rate when no EFOB rate is set yet.
        if (String(po.po_type ?? '').toLowerCase().includes('efob')) {
          const now = new Date();
          const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
          const { data: ef } = await supabase
            .from('sd_efob_fabric_cost')
            .select('rate')
            .eq('fabric_code', fabricCode)
            .eq('month', month)
            .maybeSingle();
          rateNow = ef?.rate == null ? null : Number(ef.rate);
        }
        if (rateNow == null) {
          const { data: fb } = await supabase
            .from('sd_fabric_cost_base')
            .select('finished_fabric_cost')
            .eq('fabric_code', fabricCode)
            .maybeSingle();
          rateNow = fb?.finished_fabric_cost == null ? null : Number(fb.finished_fabric_cost);
        }
      }
      if (rateNow != null && avgCons > 0 && sc?.cm_cost != null) {
        const rc = recomputeExpectedCost({ consumption: avgCons, fabricRateNow: rateNow, cmtp: Number(sc.cm_cost), fabricRateAtStd: rateAtStd });
        recomputePatch.expected_cost_recomputed = rc.expected.final;
        recomputePatch.expected_fabric_rate_now = rc.fabricRateNow;
        recomputePatch.expected_recomputed_at = new Date().toISOString();
      }
    } catch {
      /* audit-only — never block issuance on a missing-input recompute */
    }
  }

  // Explicit lock-in: the standard cost is frozen as the benchmark ONLY when the
  // issuer ticks "set as standard benchmark cost" — never silently on first issue.
  const setBenchmark = formData.get('set_benchmark') === 'true';

  const patch: Record<string, unknown> = {
    signed_po_document_url: textOrNull(formData.get('signed_po_document_url')),
    signed_cost_sheet_url: textOrNull(formData.get('signed_cost_sheet_url')),
    signed_tna_url: textOrNull(formData.get('signed_tna_url')),
    signed_po_ref_number: textOrNull(formData.get('signed_po_ref_number')),
    date_of_po_sign: dateOrNull(formData.get('date_of_po_sign')),
    first_actual_delivery_date: dateOrNull(formData.get('first_actual_delivery_date')),
    // Trim-card signing happens after the PO is raised, so it is captured here at issuance.
    trim_card_signed: formData.get('trim_card_signed') === 'true',
  };
  if (easycom) patch.easycom_po_no = easycom;
  if (!alreadyIssued) patch.po_issued_at = new Date().toISOString();
  if (setBenchmark) patch.benchmark_cost = true;
  if (costException) {
    patch.cm_override_note = String(formData.get('cost_override_note') ?? '').trim();
    patch.cm_override_by = user.email;
    patch.cm_override_at = new Date().toISOString();
  }
  Object.assign(patch, recomputePatch);

  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update(patch)
    .eq('id', id)
    .eq('status', 'approved')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Only an approved PO can be issued.');

  // Freeze the product's standard cost as the benchmark — only when explicitly set.
  if (setBenchmark) {
    const productCode = (po.product_code as string | null)?.trim();
    if (productCode) {
      await supabase
        .from('sd_standard_cost')
        .update({ frozen: true, frozen_at: new Date().toISOString() })
        .eq('product_code', productCode)
        .eq('frozen', false);
    }
  }

  if (!alreadyIssued) {
    await writeLog(
      'po_approval',
      String(id),
      `PO #${id} issued as ${easycom}`,
      'approved',
      'approved',
      user.email,
      `EasyCom PO ${easycom}`,
    );
    // Item 1: log the vendor's initial committed delivery date at issuance.
    await recordCommitment(
      po.po_ref_num as string | null,
      po.vendor_code as string | null,
      po.critical_path_first_delivery as string | null,
      user.email,
    );
  }

  // Log the above-standard-cost exception so issuance validates against the log.
  if (costException) {
    await writeLog(
      'po_approval',
      String(id),
      `PO ${easycom || `#${id}`} · above-standard cost approved at issuance`,
      'approved',
      'approved',
      user.email,
      `CMTP ₹${costException.poCm} > standard ₹${costException.stdCm}. Reason: ${String(formData.get('cost_override_note') ?? '').trim()}`,
    );
  }

  // Timeline-change flag (soft, spec: PO cycle-time / closure logic). After
  // approval the planned timeline is locked; if the ACTUAL first delivery lands
  // past the APPROVED first-delivery date, that's the "extended after approval"
  // case (the 13-day-extension incident). We never block — we surface + log it so
  // it can't slip by unnoticed.
  const actual = patch.first_actual_delivery_date as string | null;
  const approved = po.critical_path_first_delivery as string | null;
  let extNote: string | null = null;
  if (actual && approved) {
    const days = Math.round((Date.parse(actual) - Date.parse(approved)) / 86_400_000);
    if (days > 0) {
      extNote = `Delivery extended ${days} day(s) beyond approved timeline (approved ${approved} → actual ${actual}).`;
      await writeLog(
        'po_approval',
        String(id),
        `PO ${easycom || `#${id}`} · timeline extended ${days}d`,
        'approved',
        'approved',
        user.email,
        extNote,
      );
    }
  }

  revalidatePath('/po-approval');
  revalidatePath('/standard-cost');
  revalidatePath('/approvals');
  const base = alreadyIssued ? 'Signing details saved.' : `Issued as EasyCom PO ${easycom}.`;
  return done(extNote ? `${base} ⚠ ${extNote}` : base);
}

/**
 * Approver-only: review and LOCK the PO's TNA critical-path dates. Only whoever can
 * approve this PO (team for FG ≤5,000; admin for >5,000 / NPD / MAT) may enter or
 * confirm them. decideApproval hard-blocks the cost decision until this has run, so a
 * PO with a nonsensical delivery window can't get its cost approved unchecked.
 */
