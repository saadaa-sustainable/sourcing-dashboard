'use server';

import { isPlanFrozen } from '../approval';
import { loadPlanMembership } from '../queries-modules/buying-plan-analysis';

import { randomBytes } from 'crypto';
import { revalidatePath } from 'next/cache';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { createPublicClient } from '@/lib/supabase/public';
import { computeClosureCompliance, istToday, tnaBaseFor, tnaScheduleFrom, type TnaDays } from '@/lib/business-logic';
// The result type lives in lib/cost-sheet: a 'use server' module may only export async
// functions, so a type exported from here would blow up at runtime (and tsc would not say).
import { costSheetCsvUrl, parseCostSheet, type CostSheetReadResult } from '@/lib/cost-sheet';
import { recomputeExpectedCost } from '@/lib/standard-cost';
import { loadPoSubmissionChecks } from '../queries';
import type { PoSubmissionChecks } from '../queries-modules/po-checks';
import { currentUser, loadApprovedStandardCosts, loadApprovedMaterialCosts, loadAnalyticsRules } from '../queries';
import { canApprove, canDeletePo, canEdit, canSubmit, statusOnSubmit } from '../approval';
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

/** A whole number of days, or null. Negative offsets are nonsense on a critical path. */
const daysOrNull = (v: FormDataEntryValue | null) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

/** The six critical-path stages as day offsets (spec 7.3 — days are entered, dates derive). */
function readTnaDays(formData: FormData): TnaDays {
  return {
    ppSample: daysOrNull(formData.get('tna_days_pp_sample')),
    gpt: daysOrNull(formData.get('tna_days_gpt')),
    cutting: daysOrNull(formData.get('tna_days_cutting')),
    inlineQc: daysOrNull(formData.get('tna_days_inline_qc')),
    firstDelivery: daysOrNull(formData.get('tna_days_first_delivery')),
    poClosing: daysOrNull(formData.get('tna_days_po_closing')),
  };
}

/**
 * The stage columns for a set of days and a base date. Days are what the team enters and
 * what is kept; these date columns are the derived view of them, written so the Gantt,
 * the High-Risk flag and the TNA analytics keep reading plain dates as they always have.
 */
function tnaColumns(base: string | null, days: TnaDays) {
  const d = tnaScheduleFrom(base, days);
  return {
    tna_days_pp_sample: days.ppSample,
    tna_days_gpt: days.gpt,
    tna_days_cutting: days.cutting,
    tna_days_inline_qc: days.inlineQc,
    tna_days_first_delivery: days.firstDelivery,
    tna_days_po_closing: days.poClosing,
    tna_base_date: base,
    cs_pp_sample_due: d.ppSample,
    cs_gpt_due: d.gpt,
    cs_cutting_start: d.cutting,
    cs_inline_qc_due: d.inlineQc,
    critical_path_first_delivery: d.firstDelivery,
    po_closing_date: d.poClosing,
  };
}

function readPoFields(formData: FormData) {
  const rawType = String(formData.get('po_type') ?? '');
  const rawCat = String(formData.get('category') ?? 'fg').toLowerCase();
  return {
    po_type: (PO_TYPES.includes(rawType as PoType) ? rawType : null) as PoType | null,
    product_code: textOrNull(formData.get('product_code')),
    // The EasyEcom reference, filled at issuance. Never generated here: a request is
    // identified by its request_id (PR-YYMM-0001), assigned by the database.
    po_ref_num: textOrNull(formData.get('po_ref_num'))?.toUpperCase() ?? null,
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
    cad_folder_url: textOrNull(formData.get('cad_folder_url')),
    buying_plan_no: textOrNull(formData.get('buying_plan_no')),
    // Spec item 6: optional reason when the PO is outside the buying plan (ad-hoc).
    ad_hoc_reason: textOrNull(formData.get('ad_hoc_reason')),
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

  // Spec 7.3: the team enters day counts once; the stage dates are computed from them
  // against the EasyCom issue date — or, until the PO exists in EasyCom, against today,
  // which is what "if it issued now" means. Issuance rebases them (see rebasePoTna).
  const days = readTnaDays(formData);
  let base = istToday().toISOString().slice(0, 10);
  if (id) {
    const { data: cur } = await supabase
      .from('sd_po_approval')
      .select('po_issued_at')
      .eq('id', id)
      .maybeSingle();
    base = tnaBaseFor({ po_issued_at: cur?.po_issued_at as string | null }).date ?? base;
  }
  const fields = { ...readPoFields(formData), ...tnaColumns(base, days) };

  // Month-end freeze (spec item 5): a PO cannot be linked to a plan month that has already
  // closed — it belongs to the current month's plan. (Legacy free-text references are left alone.)
  if (fields.buying_plan_no && /^\d{4}-\d{2}$/.test(fields.buying_plan_no) && isPlanFrozen(`${fields.buying_plan_no}-01`)) {
    return fail(`The ${fields.buying_plan_no} buying plan is closed (month ended). Link this PO to the current month's plan.`);
  }

  // Rules-Master toggle (default on): a PO's product must exist in Standard Cost
  // (a real EasyEcom code or a temporary TMP-xxxx). Keeps PO products in lockstep
  // with the cost sheet.
  if (fields.product_code) {
    const { data: rule } = await supabase
      .from('sd_analytics_rule')
      .select('value')
      .eq('rule_key', 'restrict_plan_po_to_standard_cost')
      .maybeSingle();
    if (Number(rule?.value ?? 1) >= 1) {
      const { data: sc } = await supabase
        .from('sd_standard_cost')
        .select('product_code')
        .eq('product_code', fields.product_code)
        .maybeSingle();
      if (!sc) {
        return fail(
          `${fields.product_code} isn't in Standard Cost. Add it there first — or create a temporary product if it isn't in EasyEcom yet.`,
        );
      }
    }
  }

  // PO reference numbers must be unique across all POs (a DB partial unique index
  // is the hard guarantee; this check gives a clear message before we hit it).
  // Blank/null refs (drafts without a reference yet) are exempt.
  if (fields.po_ref_num) {
    // Case-insensitive: "…/sdalp/ven-01" and "…/SDALP/VEN-01" are the same PO. The
    // reference is stored upper-cased (readPoFields) so the DB index agrees too.
    let dupQ = supabase
      .from('sd_po_approval')
      .select('id')
      .ilike('po_ref_num', escapeLike(fields.po_ref_num))
      .limit(1);
    if (id) dupQ = dupQ.neq('id', id);
    const { data: dups } = await dupQ;
    if (dups && dups.length) {
      return fail(
        `EasyCom reference "${fields.po_ref_num}" is already recorded on request #${dups[0].id}. One EasyCom PO belongs to one request.`,
      );
    }
  }

  if (id) {
    const { data: updated, error } = await supabase
      .from('sd_po_approval')
      .update(fields)
      .eq('id', id)
      .in('status', ['draft', 'rework'])
      .select('id');
    if (error) {
      if (error.code === '23505') return fail(`EasyCom reference "${fields.po_ref_num}" is already recorded on another request.`);
      return fail(`Could not save: ${error.message}`);
    }
    // The guarded update matched nothing — the PO left draft/rework meanwhile.
    // Never report "Saved." for a write that changed no row.
    if (!updated?.length) {
      return fail('This PO is no longer editable (it has been submitted, approved or rejected). Reload to see its current state.');
    }
    revalidatePath('/po-approval');
    return { ok: true, message: 'Saved.', id };
  }

  const { data, error } = await supabase
    .from('sd_po_approval')
    .insert({ ...fields, created_by: user.email, status: 'draft' })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505') return fail(`EasyCom reference "${fields.po_ref_num}" is already recorded on another request.`);
    return fail(`Could not create PO: ${error.message}`);
  }
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

/** Escape LIKE wildcards so an ilike() equality test matches the literal reference. */
function escapeLike(s: string): string {
  return s.split('\\').join('\\\\').split('%').join('\\%').split('_').join('\\_');
}

/**
 * Spec 7.1 — the three validations shown before a PO is submitted: cost against standard /
 * last PO / cheapest ever (CM and fabric apart), TNA against the type's lead time and this
 * vendor's actual days, quantity against replenishment need and vendor capacity, plus
 * whether the product is in the buying plan. Nothing here blocks; it is what the submitter
 * confirms, with a remark, before the PO goes to approval.
 */
export async function previewPoSubmission(
  formData: FormData,
): Promise<{ ok: true; checks: PoSubmissionChecks } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  const id = Number(formData.get('id'));
  if (!id) return { ok: false, error: 'Save the PO before submitting it.' };
  try {
    const checks = await loadPoSubmissionChecks(id);
    if (!checks) return { ok: false, error: 'PO not found.' };
    return { ok: true, checks };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Could not run the checks.' };
  }
}

export async function submitPoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Save the PO before submitting it.');
  // The remark typed on the pre-submission pop-up (spec 7.1) — travels with the PO.
  const submitRemark = String(formData.get('submit_remark') ?? '').trim() || null;

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, request_id, po_ref_num, category, product_code, po_qty, rate, critical_path_first_delivery, buying_plan_no, ad_hoc_reason')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (!canSubmit(user.role, po.status as SdStatus)) {
    return fail('This PO cannot be submitted from its current state.');
  }

  // Spec item 6 — the Buying Plan is NOT a gate. Record, at submission, whether the
  // product is in the linked month's approved plan (and the plan qty at that moment) so
  // the approver sees "in plan" or "ad-hoc" + the reason; approval proceeds either way.
  const membership = await loadPlanMembership(po.product_code as string | null, po.buying_plan_no as string | null);
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
  // Locked here so it doesn't drift with the eventual approval date. "Today" is
  // the IST calendar date (the delivery date is an IST date too).
  let requestedTotalDays: number | null = null;
  if (po.critical_path_first_delivery) {
    const target = new Date(`${po.critical_path_first_delivery}T00:00:00Z`).getTime();
    const start = istToday(now).getTime();
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
      in_buying_plan: membership.inPlan,
      plan_qty_at_submit: membership.inPlan ? membership.qty.total : null,
      submit_remark: submitRemark,
    })
    .eq('id', id)
    .in('status', ['draft', 'rework'])
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) return fail('Already submitted by someone else.');

  const planNote = membership.inPlan
    ? null
    : `Ad-hoc — outside the ${membership.planMonth.slice(0, 7)} buying plan${po.ad_hoc_reason ? `: ${po.ad_hoc_reason}` : ''}`;
  const adHocNote = [planNote, submitRemark ? `Remark: ${submitRemark}` : null].filter(Boolean).join(' · ') || undefined;
  await writeLog(
    'po_approval',
    String(id),
    `PO request ${po.request_id ?? `#${id}`} · ${po.category} · ${po.product_code ?? ''}`.trim(),
    po.status as SdStatus,
    next,
    user.email,
    adHocNote,
  );
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(
    next === 'pending_l2' ? 'Submitted for admin approval.' : 'Submitted for approval.',
  );
}

/**
 * Read the cost sheet whose link is on the PO and hand back the agreed figures.
 *
 * The sheet is where the costs are actually settled, so reading it beats re-typing four
 * numbers into the form. Two ways in: the Google Sheets link (fetched as CSV, which only
 * works if the sheet is readable by anyone with the link), or the sheet pasted in. Either
 * way the figures are only suggested — the form fills them for a person to check.
 */
export async function readCostSheet(formData: FormData): Promise<CostSheetReadResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };

  const pasted = String(formData.get('pasted') ?? '').trim();
  if (pasted) return { ok: true, figures: parseCostSheet(pasted), source: 'paste' };

  const link = String(formData.get('url') ?? '').trim();
  if (!link) return { ok: false, error: 'Add the cost sheet link first (or paste the sheet).' };
  const csvUrl = costSheetCsvUrl(link);
  if (!csvUrl) {
    return {
      ok: false,
      error: 'That is not a Google Sheets link. Open the cost sheet and copy its link, or paste the sheet itself.',
    };
  }

  let text: string;
  try {
    const res = await fetch(csvUrl, {
      redirect: 'follow',
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: `Google returned ${res.status} for that sheet. It is probably not shared — set it to "anyone with the link can view", or paste the sheet instead.`,
      };
    }
    text = await res.text();
  } catch {
    return { ok: false, error: 'Could not reach the sheet. Check the link, or paste the sheet instead.' };
  }

  // A sheet that is not shared returns Google's sign-in page, with a 200, as HTML.
  if (/^\s*</.test(text) || /<html/i.test(text.slice(0, 400))) {
    return {
      ok: false,
      error:
        'That sheet is not open to anyone with the link, so it came back as a sign-in page. Share it for viewing, or paste the sheet instead.',
    };
  }

  return { ok: true, figures: parseCostSheet(text), source: 'link' };
}

/**
 * Ask for a raised PO request to be deleted. Deletion follows the approval path like
 * everything else here: the raiser asks with a reason, the ask lands in the admin's
 * queue as its own card, and only an approved ask actually marks the PO deleted
 * (see `approvePoDeleteRequest`, called from decideApproval).
 *
 * An admin asking is the decision — they are the approver, so their ask is written as
 * an already-approved request and applied at once. The record is identical either way.
 *
 * Deleting never removes a row: the PO is stamped deleted_at / deleted_by /
 * delete_reason, leaves every live list, and shows in the admin's deleted log.
 */
export async function deletePoApproval(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');

  const id = Number(formData.get('id'));
  if (!id) return fail('Invalid request.');
  const reason = String(formData.get('delete_reason') ?? '').trim();
  if (reason.length < 4) return fail('Give a reason for deleting this request.');

  const supabase = await supa();
  const { data: po } = await supabase
    .from('sd_po_approval')
    .select('id, status, created_by, request_id, product_code, vendor_code, vendor_name, po_qty, category, deleted_at')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('Request not found.');
  if (po.deleted_at) return fail('This request was already deleted.');

  const status = po.status as SdStatus;
  if (!canDeletePo(user.role, status, po.created_by as string | null, user.email)) {
    return fail(
      status === 'approved'
        ? 'An approved PO cannot be deleted — it is already a commitment. Ask an admin to close it instead.'
        : 'Only the person who raised this request (or an admin) can ask for it to be deleted.',
    );
  }

  // One undecided ask per PO (the database enforces it too, with a partial unique index).
  const { data: open } = await supabase
    .from('sd_po_delete_request')
    .select('id, requested_by')
    .eq('po_id', id)
    .in('status', ['submitted', 'pending_l2'])
    .maybeSingle();
  if (open) {
    return fail(
      `A deletion request for this PO is already with the admin (raised by ${open.requested_by ?? 'someone'}).`,
    );
  }

  const decidedNow = user.role === 'admin';
  const now = new Date().toISOString();
  const { data: req, error } = await supabase
    .from('sd_po_delete_request')
    .insert({
      po_id: id,
      request_id: po.request_id as string,
      product_code: po.product_code,
      vendor_code: po.vendor_code,
      vendor_name: po.vendor_name,
      po_qty: Number(po.po_qty || 0),
      po_status: status,
      reason,
      // An admin's own ask is the decision; anyone else's waits in the queue. Deletion is
      // always an admin call, so it never routes to the team level.
      status: decidedNow ? 'approved' : statusOnSubmit('po_delete'),
      requested_by: user.email,
      requested_at: now,
      approved_by: decidedNow ? user.email : null,
      approved_at: decidedNow ? now : null,
    })
    .select('id')
    .single();
  if (error) return fail(error.message);

  const label = `Delete PO request ${po.request_id ?? `#${id}`}${po.product_code ? ` · ${po.product_code}` : ''}`;
  if (!decidedNow) {
    await writeLog('po_delete', String(req.id), label, null, 'pending_l2', user.email, reason);
    revalidatePath('/po-approval');
    revalidatePath('/approvals');
    return done(
      `Deletion of ${po.request_id} sent to the admin for approval. It stays in your list until they decide.`,
    );
  }

  const applied = await applyPoDeletion(id, user.email, reason);
  if (!applied.ok) return applied;
  await writeLog('po_delete', String(req.id), label, null, 'approved', user.email, reason);
  revalidatePath('/po-approval');
  revalidatePath('/approvals');
  return done(
    `Deleted ${po.request_id ?? `request #${id}`}${po.product_code ? ` · ${po.product_code}` : ''}. It stays in the deleted log with your reason.`,
  );
}

/**
 * Stamp the deletion on the PO itself. The status guard is repeated here so a PO that
 * has been approved since the ask was raised cannot be deleted by approving that ask.
 */
export async function applyPoDeletion(
  poId: number,
  actorEmail: string,
  reason: string,
): Promise<ActionResult> {
  const supabase = await supa();
  const { data: updated, error } = await supabase
    .from('sd_po_approval')
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: actorEmail,
      delete_reason: reason,
    })
    .eq('id', poId)
    .is('deleted_at', null)
    .neq('status', 'approved')
    .select('id');
  if (error) return fail(error.message);
  if (!updated?.length) {
    return fail('That PO has been approved or already deleted — the deletion was not applied.');
  }
  return done();
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
    .select('id, status, product_code, po_type, po_ref_num, vendor_code, po_issued_at, critical_path_first_delivery, cm_cost, cm_override_at, buying_plan_no, tna_days_pp_sample, tna_days_gpt, tna_days_cutting, tna_days_inline_qc, tna_days_first_delivery, tna_days_po_closing')
    .eq('id', id)
    .maybeSingle();
  if (!po) return fail('PO not found.');
  if (po.status !== 'approved') return fail('Only an approved PO can be issued.');
  // Month-end freeze (spec item 5): no issuance against a plan month that has closed.
  if (po.buying_plan_no && /^\d{4}-\d{2}$/.test(po.buying_plan_no) && isPlanFrozen(`${po.buying_plan_no}-01`)) {
    return fail(`This PO is linked to the ${po.buying_plan_no} buying plan, which is closed (month ended). Re-link it to the current month's plan before issuing.`);
  }

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
      const [{ data: sc }, { data: lines }, { data: extraRows }] = await Promise.all([
        supabase.from('sd_standard_cost').select('fabric_code, cm_cost').eq('product_code', po.product_code).maybeSingle(),
        supabase.from('sd_standard_cost_line').select('size, consumption, fabric_cost').eq('product_code', po.product_code),
        // paging-ok: one product — a couple of further fabrics × nine sizes at most
        supabase.from('sd_standard_cost_extra_fabric').select('fabric_code, size, consumption, fabric_cost').eq('product_code', po.product_code),
      ]);
      const cons = (lines ?? []).map((l) => Number(l.consumption)).filter((n) => n > 0);
      const avgCons = cons.length ? cons.reduce((s, n) => s + n, 0) / cons.length : 0;
      // A line's fabric_cost is the size's WHOLE fabric cost. The rate baked into the
      // standard is the FIRST fabric's, so the further fabrics' share comes off first.
      const extras = (extraRows ?? []) as { fabric_code: string; size: string | null; consumption: number | null; fabric_cost: number | null }[];
      const extraBySize = new Map<string, number>();
      for (const e of extras) {
        const k = String(e.size ?? '').toUpperCase();
        extraBySize.set(k, (extraBySize.get(k) ?? 0) + (Number(e.fabric_cost) || 0));
      }
      const baked = (lines ?? [])
        .map((l) => {
          const c = Number(l.consumption);
          if (!(c > 0)) return 0;
          return (Number(l.fabric_cost) - (extraBySize.get(String(l.size ?? '').toUpperCase()) ?? 0)) / c;
        })
        .filter((n) => n > 0);
      const rateAtStd = baked.length ? baked.reduce((s, n) => s + n, 0) / baked.length : null;
      // The further fabrics at TODAY's finished rates (average consumption × rate), falling
      // back to the cost saved on the sheet when a fabric has no rate on the master.
      let extraFabricNow = 0;
      if (extras.length) {
        const codes = [...new Set(extras.map((e) => e.fabric_code))];
        const { data: rates } = await supabase
          .from('sd_fabric_cost_base')
          .select('fabric_code, finished_fabric_cost')
          .in('fabric_code', codes);
        const rateOf = new Map(
          ((rates ?? []) as { fabric_code: string; finished_fabric_cost: number | null }[]).map((r) => [
            r.fabric_code,
            r.finished_fabric_cost == null ? null : Number(r.finished_fabric_cost),
          ]),
        );
        for (const code of codes) {
          const rows = extras.filter((e) => e.fabric_code === code && Number(e.consumption) > 0);
          if (!rows.length) continue;
          const avgC = rows.reduce((s, e) => s + Number(e.consumption), 0) / rows.length;
          const rNow = rateOf.get(code) ?? null;
          extraFabricNow +=
            rNow != null ? rNow * avgC : rows.reduce((s, e) => s + (Number(e.fabric_cost) || 0), 0) / rows.length;
        }
      }
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
        // Final-price margin from Rules Master (margin_pct, a percent) — REJ/OH removed.
        const marginPct = (await loadAnalyticsRules()).margin_pct / 100;
        const rc = recomputeExpectedCost(
          { consumption: avgCons, fabricRateNow: rateNow, cmtp: Number(sc.cm_cost), fabricRateAtStd: rateAtStd, extraFabric: extraFabricNow },
          { marginPct },
        );
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
  // Spec 7.3 — the moment the PO exists in EasyCom, the critical path is recomputed from
  // that date. Nothing is re-typed: the day counts entered at submission are the plan, and
  // a PO issued ten days late simply carries every stage ten days with it.
  if (!alreadyIssued) {
    const issueDate = istToday().toISOString().slice(0, 10);
    Object.assign(
      patch,
      tnaColumns(issueDate, {
        ppSample: po.tna_days_pp_sample as number | null,
        gpt: po.tna_days_gpt as number | null,
        cutting: po.tna_days_cutting as number | null,
        inlineQc: po.tna_days_inline_qc as number | null,
        firstDelivery: po.tna_days_first_delivery as number | null,
        poClosing: po.tna_days_po_closing as number | null,
      }),
      { tna_rebased_at: new Date().toISOString() },
    );
  }
  // The EasyEcom reference, if the issuer has it — recorded against the request id so the
  // two can be matched later. Optional: the PO number is what actually links them.
  const eeRef = textOrNull(formData.get('po_ref_num'));
  if (eeRef) patch.po_ref_num = eeRef.toUpperCase();
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
