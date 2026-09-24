import type { NextRequest } from 'next/server';
import { createAdminClient, hasSupabaseAdminEnv } from '@/lib/supabase/admin';
import { generateInventoryReport } from '@/lib/inventory-report';
import { istToday } from '@/lib/business-logic';

// Supabase storage + a 13k-row read need the Node runtime.
export const runtime = 'nodejs';
export const maxDuration = 120;

/**
 * The daily inventory report: writes the CSV and posts it to the Supply Chain channel.
 *
 * Meant to be called RIGHT AFTER the morning BigQuery sync lands (BqSync.gs), so the
 * figures are the ones that just arrived rather than whatever a clock hoped for. It is a
 * plain authenticated GET, so a Vercel cron entry works just as well.
 *
 * Idempotent: a day already posted is skipped unless `?force=1`. `?post=0` builds and
 * stores the file without sending anything to Slack — the safe way to try it.
 *
 * Auth: `Authorization: Bearer $CRON_SECRET`, same as the other cron routes.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const force = request.nextUrl.searchParams.get('force') === '1';
  const post = request.nextUrl.searchParams.get('post') !== '0';
  const startedAt = new Date().toISOString();
  const day = istToday().toISOString().slice(0, 10);

  if (!force && post && hasSupabaseAdminEnv()) {
    const { data: existing } = await createAdminClient()
      .from('sd_inventory_report')
      .select('slack_posted_at')
      .eq('report_day', day)
      .maybeSingle();
    if (existing?.slack_posted_at) {
      return Response.json({ ok: true, startedAt, day, skipped: 'already posted', postedAt: existing.slack_posted_at });
    }
  }

  const result = await generateInventoryReport({ post, by: 'cron' });
  if (!result.ok) return Response.json({ ok: false, startedAt, day, error: result.error }, { status: 500 });

  return Response.json({
    ok: true,
    startedAt,
    day,
    posted: result.posted,
    slackError: result.slackError,
    storagePath: result.storagePath,
    summary: result.summary,
  });
}
