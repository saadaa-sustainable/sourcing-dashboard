import { countPendingApprovals, currentUser } from '@/lib/forms/queries';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Powers the topbar notification bell. Auth-gated to signed-in users; returns the
// count of items in the shared approval queue (submitted / pending_l2).
export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role === 'viewer') return Response.json({ count: 0 });
    const count = await countPendingApprovals();
    return Response.json({ count });
  } catch {
    return Response.json({ count: 0 });
  }
}
