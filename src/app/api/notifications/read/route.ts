import { currentUser } from '@/lib/forms/queries';
import { markNotificationsRead } from '@/lib/notifications.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Marks the notices the user has seen in the bell as read.
export async function POST(req: Request) {
  try {
    const user = await currentUser();
    if (!user) return Response.json({ ok: false }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)).slice(0, 100) : [];
    await markNotificationsRead(user.email, ids);
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
