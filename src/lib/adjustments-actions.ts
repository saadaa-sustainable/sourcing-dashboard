'use server';

import { currentUser } from '@/lib/forms/queries';
import { refreshSource, type AdjustmentSource, type RefreshResult } from '@/lib/adjustments';

// Refresh one adjustment source (live BigQuery re-pull), enforcing the per-user
// hourly cap. Identity comes from the session — the client cannot spoof the email.
export async function refreshAdjustmentAction(source: AdjustmentSource): Promise<RefreshResult> {
  if (source !== 'po' && source !== 'cutting') {
    return { ok: false, source: 'po', rows: [], remaining: 0, retryAfterMinutes: 0, error: 'Unknown source.' };
  }

  const user = await currentUser();
  const email = user?.email ?? null;
  if (!email) {
    return { ok: false, source, rows: [], remaining: 0, retryAfterMinutes: 0, error: 'You must be signed in to refresh.' };
  }

  try {
    return await refreshSource(email, source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, source, rows: [], remaining: 0, retryAfterMinutes: 0, error: `Refresh failed: ${message}` };
  }
}
