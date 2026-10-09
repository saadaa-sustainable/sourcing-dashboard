'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { generateVendorCapacityReport } from '@/lib/vendor-capacity-report';
import { signPlanReport } from '@/lib/plan-report';
import { type ActionResult, fail, done } from './_shared';

/** Admin: build the Vendor Capacity month report now, optionally posting it to management. */
export async function generateVendorCapacityReportAction(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (user.role !== 'admin') return fail('Only an admin can generate the monthly report.');
  const month = String(formData.get('month') ?? '');
  if (!/^\d{4}-\d{2}-01$/.test(month)) return fail('Invalid month.');
  const post = String(formData.get('post') ?? '') === '1';
  const res = await generateVendorCapacityReport(month, { post, by: user.email });
  revalidatePath('/vendor-capacity');
  if (!res.ok) return fail(res.error);
  const kb = Math.max(1, Math.round(res.bytes / 1024));
  if (!post) return done(`Report generated (${kb} KB). Not sent to management.`);
  if (res.posted) return done(`Report generated (${kb} KB) and sent to management on Slack.`);
  return done(
    `Report generated (${kb} KB) but NOT sent — ${res.slackConfigured ? 'the Slack post failed (see the report card).' : 'no Slack webhook is configured (set SLACK_MANAGEMENT_WEBHOOK_URL).'}`,
  );
}

/** Signed download link for a generated Vendor Capacity report (any signed-in SAADAA user). */
export async function getVendorCapacityReportUrl(storagePath: string): Promise<{ url: string } | { error: string }> {
  const user = await currentUser();
  if (!user) return { error: 'Not signed in.' };
  const path = String(storagePath ?? '');
  if (!/^vendor-capacity\/\d{4}-\d{2}\.pdf$/.test(path)) return { error: 'Unknown report.' };
  const url = await signPlanReport(path);
  return url ? { url } : { error: 'Could not create a download link.' };
}
