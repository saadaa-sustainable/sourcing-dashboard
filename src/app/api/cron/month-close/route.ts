import type { NextRequest } from 'next/server';
import { addMonths, monthStart } from '@/lib/forms/approval';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { generatePlanReport } from '@/lib/plan-report';

// jsPDF + Supabase storage need the Node runtime; the report reads a month of PO lines.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Month-close (spec item 5). Vercel Cron hits this on the 1st at 03:30 UTC = 09:00 IST
 * (see vercel.json). The plan for the month that just ended is frozen by the date rule
 * already; this job generates its analytical PDF and posts it to the Supply Chain
 * channel. Idempotent: if the month was already posted, it does nothing unless ?force=1.
 *
 * ?month=YYYY-MM-01 reports a specific month (default: the month that just ended).
 * Vercel sends `Authorization: Bearer $CRON_SECRET`; anything else is rejected.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const monthParam = request.nextUrl.searchParams.get('month') ?? '';
  const planMonth = /^\d{4}-\d{2}-01$/.test(monthParam) ? monthParam : addMonths(monthStart(), -1);
  const force = request.nextUrl.searchParams.get('force') === '1';
  const startedAt = new Date().toISOString();

  if (!force && hasSupabaseAdminEnv()) {
    const { data: existing } = await createAdminClient()
      .from('sd_plan_report')
      .select('slack_posted_at')
      .eq('plan_month', planMonth)
      .eq('plan_type', 'fg')
      .maybeSingle();
    if (existing?.slack_posted_at) {
      return Response.json({ ok: true, startedAt, planMonth, skipped: 'already posted', postedAt: existing.slack_posted_at });
    }
  }

  const result = await generatePlanReport(planMonth, { post: true, by: 'cron' });
  const status = result.ok ? 200 : 500;
  return Response.json({ startedAt, finishedAt: new Date().toISOString(), planMonth, ...result }, { status });
}
