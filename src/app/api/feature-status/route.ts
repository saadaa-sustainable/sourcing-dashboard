import { currentUser, NotConfiguredError } from '@/lib/forms/queries';
import { loadFeatureStatuses } from '@/lib/feature-status.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Sprint-phase feature statuses (item 1), fetched client-side by the topbar badge
// so FormLayout stays client-safe (no server-only import into client bundles).
export async function GET() {
  try {
    const user = await currentUser();
    if (!user) return Response.json({});
    return Response.json(await loadFeatureStatuses());
  } catch (error) {
    if (error instanceof NotConfiguredError) return Response.json({});
    return Response.json({});
  }
}
