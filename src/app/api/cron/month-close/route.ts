import type { NextRequest } from 'next/server';
import { addMonths, monthStart } from '@/lib/forms/approval';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { generatePlanReport } from '@/lib/plan-report';
import { generateVendorCapacityReport, VC_REPORT_TYPE } from '@/lib/vendor-capacity-report';

// jsPDF + Supabase storage need the Node runtime; the report reads a month of PO lines.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * Month-close (spec item 5). Vercel Cron hits this on the 1st at 03:30 UTC = 09:00 IST
 * (see vercel.json). The plan for the month that just ended is frozen by the date rule
 * already; this job generates its analytical PDF and posts it to the Supply Chain
 * channel. Idempotent: if the month was already posted, it does nothing unless ?force=1.
 * The same run sends Vendor Capacity's mandatory monthly report to management (2026-10-09),
 * with its own idempotency check — one report failing never stops the other.
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

  const postedAlready = async (type: string) => {
    if (force || !hasSupabaseAdminEnv()) return null;
    const { data } = await createAdminClient()
      .from('sd_plan_report')
      .select('slack_posted_at')
      .eq('plan_month', planMonth)
      .eq('plan_type', type)
      .maybeSingle();
    return (data as { slack_posted_at: string | null } | null)?.slack_posted_at ?? null;
  };

  const [fgPosted, vcPosted] = await Promise.all([postedAlready('fg'), postedAlready(VC_REPORT_TYPE)]);
  const [buyingPlan, vendorCapacity] = await Promise.all([
    fgPosted ? Promise.resolve({ ok: true as const, skipped: 'already posted', postedAt: fgPosted }) : generatePlanReport(planMonth, { post: true, by: 'cron' }),
    vcPosted ? Promise.resolve({ ok: true as const, skipped: 'already posted', postedAt: vcPosted }) : generateVendorCapacityReport(planMonth, { post: true, by: 'cron' }),
  ]);
  const ok = buyingPlan.ok && vendorCapacity.ok;
  return Response.json({ ok, startedAt, finishedAt: new Date().toISOString(), planMonth, buyingPlan, vendorCapacity }, { status: ok ? 200 : 500 });
}
