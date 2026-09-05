'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { currentUser } from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import type { ActionResult } from '@/lib/forms/actions';
import type { FeedbackMessage, FeedbackStatus } from '@/lib/feedback';

const KINDS = ['bug', 'suggestion', 'question'];
const SEVERITIES = ['low', 'medium', 'high', 'blocker'];
const STATUSES = ['new', 'acknowledged', 'in_progress', 'resolved', 'wont_fix'];
// A compressed screenshot is ~50–300 KB of base64; cap generously and reject the rest.
const MAX_SHOT = 3_500_000;

function cleanShot(v: FormDataEntryValue | null): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s || !s.startsWith('data:image/')) return null;
  if (s.length > MAX_SHOT) return null;
  return s;
}

/** File a new report (creates the feedback + its first message). */
export async function submitFeedback(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to file feedback.' };

  const kindRaw = String(formData.get('kind') ?? 'bug');
  const kind = KINDS.includes(kindRaw) ? kindRaw : 'bug';
  const sevRaw = String(formData.get('severity') ?? 'medium');
  const severity = SEVERITIES.includes(sevRaw) ? sevRaw : 'medium';
  const title = String(formData.get('title') ?? '').trim();
  const body = String(formData.get('body') ?? '').trim();
  const page_path = String(formData.get('page_path') ?? '').trim() || null;
  if (!title) return { ok: false, error: 'Give the report a short title.' };
  if (!body) return { ok: false, error: 'Describe the issue or idea.' };

  let context: unknown = null;
  try {
    const raw = String(formData.get('context') ?? '');
    context = raw ? JSON.parse(raw) : null;
  } catch {
    context = null;
  }
  const screenshot = cleanShot(formData.get('screenshot'));

  const supabase = await createClient();
  const { data: fb, error } = await supabase
    .from('sd_feedback')
    .insert({ kind, title, severity, page_path, context, submitted_by: user.email })
    .select('id')
    .single();
  if (error || !fb) return { ok: false, error: error?.message ?? 'Could not file the report.' };

  const { error: msgErr } = await supabase
    .from('sd_feedback_message')
    .insert({ feedback_id: fb.id, author_email: user.email, body, screenshot });
  if (msgErr) return { ok: false, error: msgErr.message };

  revalidatePath('/feedback');
  return { ok: true, message: 'Thanks — your report was sent to the developer.', id: fb.id as number };
}

/** Add a message (reply) to an existing report; either side, optional screenshot. */
export async function replyFeedback(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'No permission.' };

  const feedback_id = Number(formData.get('feedback_id'));
  const body = String(formData.get('body') ?? '').trim();
  const screenshot = cleanShot(formData.get('screenshot'));
  if (!feedback_id) return { ok: false, error: 'Missing report.' };
  if (!body && !screenshot) return { ok: false, error: 'Write a reply or attach a screenshot.' };

  const supabase = await createClient();
  const { error } = await supabase
    .from('sd_feedback_message')
    .insert({ feedback_id, author_email: user.email, body: body || null, screenshot });
  if (error) return { ok: false, error: error.message };
  // Bump the parent so it re-sorts to the top of the inbox.
  await supabase.from('sd_feedback').update({ updated_at: new Date().toISOString() }).eq('id', feedback_id);

  revalidatePath('/feedback');
  return { ok: true, message: 'Reply added.' };
}

/** Developer-only: move a report through its status (and optionally severity). */
export async function setFeedbackStatus(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (user.role !== 'admin') return { ok: false, error: 'Only the developer/admin can change status.' };

  const feedback_id = Number(formData.get('feedback_id'));
  const status = String(formData.get('status') ?? '');
  if (!feedback_id || !STATUSES.includes(status)) return { ok: false, error: 'Invalid status.' };

  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  const sev = String(formData.get('severity') ?? '');
  if (SEVERITIES.includes(sev)) patch.severity = sev;

  const supabase = await createClient();
  const { error } = await supabase.from('sd_feedback').update(patch).eq('id', feedback_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath('/feedback');
  return { ok: true, message: `Marked ${status.replace('_', ' ')}.` };
}

/** Read one report's full thread (messages + screenshots) — for the expanded view. */
export async function getFeedbackThread(feedbackId: number): Promise<{ messages: FeedbackMessage[] }> {
  const user = await currentUser();
  if (!user) return { messages: [] };
  const supabase = await createClient();
  const { data } = await supabase
    .from('sd_feedback_message')
    .select('id, feedback_id, author_email, body, screenshot, created_at')
    .eq('feedback_id', feedbackId)
    .order('created_at', { ascending: true });
  return { messages: (data ?? []) as FeedbackMessage[] };
}

// Re-exported for the status enum type in callers.
export type { FeedbackStatus };
