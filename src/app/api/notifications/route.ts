import { currentUser } from '@/lib/forms/queries';
import { loadMyNotifications } from '@/lib/notifications.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The bell's "For you" list: notices to this user or their role, with the unread count.
export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role === 'viewer') return Response.json({ items: [], unread: 0 });
    return Response.json(await loadMyNotifications(user.email));
  } catch {
    return Response.json({ items: [], unread: 0 });
  }
}
