import { currentUser, loadApprovalNotifications } from '@/lib/forms/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Powers the topbar notification bell. Auth-gated to signed-in users; returns the
// number of items THIS user can act on — the same list the bell's dropdown shows,
// so the badge and the list never disagree.
export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role === 'viewer') return Response.json({ count: 0 });
    const count = (await loadApprovalNotifications(user.role)).length;
    return Response.json({ count });
  } catch {
    return Response.json({ count: 0 });
  }
}
