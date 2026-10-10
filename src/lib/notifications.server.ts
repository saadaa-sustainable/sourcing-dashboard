import 'server-only';
import { createClient } from '@/lib/supabase/server';
import type { SdRole } from '@/lib/forms/types';

/** One in-app notice, as the bell shows it. */
export type AppNotification = {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  unread: boolean;
};

/**
 * Raise an in-app notice: to one person (recipientEmail) or to everyone with a role
 * (audienceRole, e.g. the team). Best-effort: a failed notice never fails the action that
 * raised it. Written as the signed-in user, so the table's rules apply.
 */
export async function createNotification(n: {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  audienceRole?: SdRole | null;
  recipientEmail?: string | null;
  createdBy?: string | null;
}): Promise<void> {
  if (!n.audienceRole && !n.recipientEmail) return;
  try {
    const supabase = await createClient();
    await supabase.from('sd_notification').insert({
      kind: n.kind,
      title: n.title.slice(0, 300),
      body: n.body ? n.body.slice(0, 1000) : null,
      link: n.link ?? null,
      audience_role: n.audienceRole ?? null,
      recipient_email: n.recipientEmail ? n.recipientEmail.toLowerCase() : null,
      created_by: n.createdBy ?? null,
    });
  } catch {
    /* a notice must never break the action */
  }
}

/** The latest notices addressed to the signed-in user or their role, newest first. */
export async function loadMyNotifications(email: string): Promise<{ items: AppNotification[]; unread: number }> {
  const supabase = await createClient();
  // paging-ok: the bell shows the newest 30 notices; older ones are pruned at 90 days
  const { data } = await supabase
    .from('sd_notification')
    .select('id, kind, title, body, link, created_at, created_by')
    .order('created_at', { ascending: false })
    .limit(30);
  // A notice someone raised themselves (e.g. an admin who is also on the team) is not news to them.
  const rows = ((data ?? []) as { id: number; kind: string; title: string; body: string | null; link: string | null; created_at: string; created_by: string | null }[])
    .filter((r) => (r.created_by ?? '').toLowerCase() !== email.toLowerCase());
  const ids = rows.map((r) => r.id);
  const read = new Set<number>();
  if (ids.length) {
    // paging-ok: at most 30 ids, one read row each
    const { data: reads } = await supabase.from('sd_notification_read').select('notification_id').in('notification_id', ids);
    for (const r of (reads ?? []) as { notification_id: number }[]) read.add(Number(r.notification_id));
  }
  const items = rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    createdAt: r.created_at,
    unread: !read.has(Number(r.id)),
  }));
  return { items, unread: items.filter((i) => i.unread).length };
}

/** Mark these notices read for the signed-in user. */
export async function markNotificationsRead(email: string, ids: number[]): Promise<void> {
  if (!ids.length) return;
  const supabase = await createClient();
  await supabase
    .from('sd_notification_read')
    .upsert(ids.map((id) => ({ notification_id: id, user_email: email.toLowerCase() })), {
      onConflict: 'notification_id,user_email',
      ignoreDuplicates: true,
    });
}
