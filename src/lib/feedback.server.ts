import { createClient } from '@/lib/supabase/server';
import type { FeedbackKind, FeedbackSeverity, FeedbackStatus, FeedbackListItem } from '@/lib/feedback';

// Client-safe types + label maps live in ./feedback so client components don't pull
// this server-only module (next/headers). Re-exported for server-side importers.
export type { FeedbackKind, FeedbackSeverity, FeedbackStatus, FeedbackMessage, FeedbackListItem } from '@/lib/feedback';
export { FEEDBACK_KIND_LABEL, FEEDBACK_STATUS_LABEL, FEEDBACK_SEVERITY_LABEL } from '@/lib/feedback';

/**
 * Feedback list, newest first. RLS lets any staff read the whole board; the page
 * shows all of it to admins (the developer inbox) and just the caller's own reports
 * to everyone else. Screenshots are NOT loaded here — only when a thread is opened.
 */
export async function loadFeedbackList(viewerEmail: string): Promise<FeedbackListItem[]> {
  const supabase = await createClient();
  const [{ data: rows }, { data: msgs }, { data: votes }] = await Promise.all([
    supabase
      .from('sd_feedback')
      .select('id, kind, title, severity, status, page_path, related_ref, tags, assignee, resolution, submitted_by, submitted_at, updated_at')
      .order('updated_at', { ascending: false }),
    supabase.from('sd_feedback_message').select('feedback_id, screenshot'),
    supabase.from('sd_feedback_vote').select('feedback_id, voter_email'),
  ]);

  const counts = new Map<number, { n: number; shot: boolean }>();
  for (const m of msgs ?? []) {
    const c = counts.get(m.feedback_id as number) ?? { n: 0, shot: false };
    c.n += 1;
    if (m.screenshot) c.shot = true;
    counts.set(m.feedback_id as number, c);
  }
  const voteAgg = new Map<number, { n: number; mine: boolean }>();
  for (const v of votes ?? []) {
    const a = voteAgg.get(v.feedback_id as number) ?? { n: 0, mine: false };
    a.n += 1;
    if (v.voter_email === viewerEmail) a.mine = true;
    voteAgg.set(v.feedback_id as number, a);
  }

  return (rows ?? []).map((r) => {
    const c = counts.get(r.id as number);
    const v = voteAgg.get(r.id as number);
    return {
      id: r.id as number,
      kind: r.kind as FeedbackKind,
      title: r.title as string,
      severity: r.severity as FeedbackSeverity,
      status: r.status as FeedbackStatus,
      page_path: (r.page_path as string | null) ?? null,
      related_ref: (r.related_ref as string | null) ?? null,
      tags: (r.tags as string[] | null) ?? [],
      assignee: (r.assignee as string | null) ?? null,
      resolution: (r.resolution as string | null) ?? null,
      submitted_by: (r.submitted_by as string | null) ?? null,
      submitted_at: r.submitted_at as string,
      updated_at: r.updated_at as string,
      messageCount: c?.n ?? 0,
      hasScreenshot: c?.shot ?? false,
      voteCount: v?.n ?? 0,
      votedByMe: v?.mine ?? false,
    };
  });
}

/** New (untriaged) feedback count — for the developer's notification badge. */
export async function loadNewFeedbackCount(): Promise<number> {
  const supabase = await createClient();
  const { count } = await supabase
    .from('sd_feedback')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'new');
  return count ?? 0;
}
