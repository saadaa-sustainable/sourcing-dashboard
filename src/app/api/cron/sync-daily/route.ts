import type { NextRequest } from 'next/server';
import { runDailySync, type SyncTarget } from '@/lib/bq-sync';

// BigQuery client needs the Node runtime (not edge). The sync upserts ~20k rows
// over HTTP, so give it headroom — raise on Vercel only if a run is truncated.
export const runtime = 'nodejs';
export const maxDuration = 300;

// Vercel Cron hits this daily at 06:00 IST (see vercel.json). Vercel automatically
// sends `Authorization: Bearer $CRON_SECRET` when the CRON_SECRET env var is set;
// we reject anything else so the endpoint can't be triggered by outsiders.
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  // ?only=grn|doq|product-master runs a single target; default runs all three.
  const onlyParam = request.nextUrl.searchParams.get('only');
  const only = (['product-master', 'doq', 'grn'] as const).find((t) => t === onlyParam);

  const startedAt = new Date().toISOString();
  try {
    const summary = await runDailySync(only as SyncTarget | undefined);
    return Response.json({ ok: true, startedAt, finishedAt: new Date().toISOString(), summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, startedAt, error: message }, { status: 500 });
  }
}
