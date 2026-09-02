import { currentUser, loadApprovalNotifications } from '@/lib/forms/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Powers the notification bell's dropdown: the pending items the signed-in user
// can act on. Auth-gated; viewers get nothing. Kept in sync with the bell badge
// count (same three sources).
export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role === 'viewer') return Response.json({ items: [] });
    const items = await loadApprovalNotifications(user.role);
    return Response.json({ items });
  } catch {
    return Response.json({ items: [] });
  }
}
