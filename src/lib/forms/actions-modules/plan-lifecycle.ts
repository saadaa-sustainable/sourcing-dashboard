'use server';

// Buying Plan month-end lifecycle (spec item 5): post-approval / post-freeze amendments
// routed through approval, and the month report (generate / post / download).

import { revalidatePath } from 'next/cache';
import { isPlanFrozen, monthLabel } from '../approval';
import { currentUser } from '../queries';
import { notifyPlanAmendmentSlack } from '@/lib/slack';
import { generatePlanReport, signPlanReport } from '@/lib/plan-report';
import { type ActionResult, fail, done, supa, writeLog, textOrNull } from './_shared';

/**
 * Request an amendment to an APPROVED plan (the "maroon fabric" case: the team realises a
 * product was missed after approval / after the month closed). The plan goes back to
 * 'rework' so it can be edited, and must be re-approved before the change counts. The
 * approval quality is downgraded (edited; amended-after-freeze when the month is closed)
 * so the first-time-approval metric stays honest.
 */
export async function requestPlanAmendment(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role === 'viewer') return fail('You do not have permission to amend the buying plan.');

  const planId = Number(formData.get('plan_id'));
  if (!planId) return fail('Plan not found.');
  const note = textOrNull(formData.get('note'));
  if (!note) return fail('Say what needs to change and why — the note goes to the approver.');

  const supabase = await supa();
  const { data: plan } = await supabase
    .from('sd_buying_plan')
    .select('id, plan_month, plan_type, status')
    .eq('id', planId)
    .maybeSingle();
  if (!plan) return fail('Plan not found.');
  if (plan.status !== 'approved') {
    return fail(
      plan.status === 'rework'
        ? 'This plan is already open for rework — edit it and resubmit.'
        : 'Only an approved plan can be amended; a draft or submitted plan is edited the normal way.',
    );
  }

  const planMonth = String(plan.plan_month);
  const frozen = isPlanFrozen(planMonth);
  const now = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from('sd_buying_plan')
    .update({
      status: 'rework',
      rework_notes: `Amendment requested: ${note}`,
      reworked_by: user.email,
      reworked_at: now,
      edited_before_approval: true,
      amendment_requested_by: user.email,
      amendment_requested_at: now,
      ...(frozen ? { amended_after_freeze: true } : {}),
    })
    .eq('id', planId)
    .eq('status', 'approved')
    .select('id');
  if (error) return fail(`Could not open the plan for amendment: ${error.message}`);
  if (!updated?.length) return fail('The plan changed under you — reload and try again.');

  await writeLog('buying_plan', String(planId), `Buying plan ${planMonth.slice(0, 7)}`, 'approved', 'rework', user.email, `Amendment requested: ${note}`);
  await notifyPlanAmendmentSlack({ monthLabel: monthLabel(planMonth), by: user.email, note, frozen });

  revalidatePath('/buying-plan');
  revalidatePath('/approvals');
  return done(
    `${monthLabel(planMonth)} plan is open for amendment${frozen ? ' (month already closed)' : ''}. Make the change and resubmit — it must be approved again.`,
  );
}

/** Admin: generate the month report now, optionally posting it to the Supply Chain channel. */
export async function generatePlanReportAction(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can generate the month report.');
  const planMonth = String(formData.get('plan_month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(planMonth)) return fail('Invalid plan month.');
  const post = String(formData.get('post') ?? '') === '1';

  const res = await generatePlanReport(planMonth, { post, by: user.email });
  revalidatePath('/buying-plan');
  if (!res.ok) return fail(res.error);
  const kb = Math.max(1, Math.round(res.bytes / 1024));
  if (!post) return done(`Report generated (${kb} KB). Not posted to Slack.`);
  if (res.posted) return done(`Report generated (${kb} KB) and posted to the Supply Chain channel.`);
  return done(
    `Report generated (${kb} KB) but NOT posted — ${res.slackConfigured ? 'the Slack post failed (see the report card).' : 'no Slack webhook is configured yet (set SLACK_SUPPLY_CHAIN_WEBHOOK_URL).'}`,
  );
}

/** Signed download link for a generated report (any signed-in saadaa user). */
export async function getPlanReportUrl(storagePath: string): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  const path = String(storagePath ?? '');
  if (!path.startsWith('buying-plan/')) return { error: 'Unknown report.' };
  const url = await signPlanReport(path);
  return url ? { url } : { error: 'Could not create a download link.' };
}
