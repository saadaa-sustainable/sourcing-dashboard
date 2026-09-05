import { currentUser } from '@/lib/forms/queries';
import { loadNewFeedbackCount } from '@/lib/feedback.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Powers the developer's feedback bell — count of NEW (untriaged) reports. Admin only.
export async function GET() {
  try {
    const user = await currentUser();
    if (!user || user.role !== 'admin') return Response.json({ count: 0 });
    const count = await loadNewFeedbackCount();
    return Response.json({ count });
  } catch {
    return Response.json({ count: 0 });
  }
}
