import type { NextRequest } from 'next/server';
import { autoSubmitNextMonthPlan, isLastDayOfMonthIst } from '@/lib/plan-auto-submit';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Month-end auto-submit (spec item 5). Vercel Cron runs this daily at 18:00 UTC
 * (23:30 IST) on the 28th–31st (cron cannot express "last day of month"); it acts only
 * when the next IST day is the 1st, submitting next month's draft FG plan for approval.
 *
 * ?month=YYYY-MM-01 targets a specific plan month; ?force=1 skips the last-day check
 * (for a manual run). Vercel sends `Authorization: Bearer $CRON_SECRET`.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const force = request.nextUrl.searchParams.get('force') === '1';
  const monthParam = request.nextUrl.searchParams.get('month') ?? '';
  const startedAt = new Date().toISOString();

  if (!force && !monthParam && !isLastDayOfMonthIst()) {
    return Response.json({ ok: true, startedAt, skipped: 'not the last day of the month (IST)' });
  }

  const result = await autoSubmitNextMonthPlan(monthParam || undefined);
  const ok = result.outcome !== 'error';
  return Response.json({ ok, startedAt, finishedAt: new Date().toISOString(), ...result }, { status: ok ? 200 : 500 });
}
