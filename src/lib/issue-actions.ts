'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { currentUser } from '@/lib/forms/queries';
import { canEdit } from '@/lib/forms/approval';
import type { ActionResult } from '@/lib/forms/actions';
import { ISSUE_CATEGORIES, routeFor, type IssueCategory, type IssueMessage, type IssueSeverity } from '@/lib/issues';
import { loadIssueRoutes } from '@/lib/issues.server';

const SEVERITIES: IssueSeverity[] = ['low', 'medium', 'high', 'blocker'];
const isCategory = (v: string): v is IssueCategory => ISSUE_CATEGORIES.some((c) => c.key === v);

function touch() {
  revalidatePath('/issues');
  revalidatePath('/');
}

/** Raise an issue to a person (or to whoever the category routes to). */
export async function raiseIssue(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'You do not have permission to raise issues.' };

  const category = String(formData.get('category') ?? '').trim();
  const title = String(formData.get('title') ?? '').trim();
  const detail = String(formData.get('detail') ?? '').trim() || null;
  const related_ref = String(formData.get('related_ref') ?? '').trim().toUpperCase() || null;
  const page_path = String(formData.get('page_path') ?? '').trim() || null;
  const sevRaw = String(formData.get('severity') ?? 'medium');
  const severity = SEVERITIES.includes(sevRaw as IssueSeverity) ? (sevRaw as IssueSeverity) : 'medium';
  const pickedAssignee = String(formData.get('assignee') ?? '').trim().toLowerCase() || null;

  if (!isCategory(category)) return { ok: false, error: 'Pick what the issue is about.' };
  if (!title) return { ok: false, error: 'Say what is wrong, in one line.' };

  // A named person wins; otherwise the category's route; otherwise it waits unassigned.
  const routes = await loadIssueRoutes();
  const routed = routeFor(category, routes);
  const assignee = pickedAssignee ?? routed;
  const now = new Date().toISOString();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('sd_issue')
    .insert({
      category,
      title,
      detail,
      related_ref,
      page_path,
      source: 'manual',
      severity,
      status: 'open',
      raised_by: user.email,
      raised_at: now,
      assignee,
      assigned_via: assignee ? (pickedAssignee ? 'manual' : 'route') : null,
      assigned_at: assignee ? now : null,
      updated_at: now,
    })
    .select('id')
    .single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not raise the issue.' };

  touch();
  return {
    ok: true,
    id: data.id as number,
    message: assignee ? `Raised and assigned to ${assignee}.` : 'Raised. No one is routed for this category yet — assign it from the list.',
  };
}

/** Add a message to an issue's thread. */
export async function replyIssue(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'No permission.' };
  const issue_id = Number(formData.get('issue_id'));
  const body = String(formData.get('body') ?? '').trim();
  if (!issue_id) return { ok: false, error: 'Missing issue.' };
  if (!body) return { ok: false, error: 'Write something.' };

  const supabase = await createClient();
  const { error } = await supabase.from('sd_issue_message').insert({ issue_id, author_email: user.email, body });
  if (error) return { ok: false, error: error.message };
  await supabase.from('sd_issue').update({ updated_at: new Date().toISOString() }).eq('id', issue_id);
  touch();
  return { ok: true };
}

/**
 * Move an issue: assign, start, resolve (with what was done), dismiss (with why), reopen.
 * Any team member can act — the tracker is shared work, not a personal inbox.
 */
export async function updateIssue(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (!canEdit(user.role, 'draft')) return { ok: false, error: 'No permission.' };
  const issue_id = Number(formData.get('issue_id'));
  const action = String(formData.get('action') ?? '');
  const note = String(formData.get('note') ?? '').trim();
  const assignee = String(formData.get('assignee') ?? '').trim().toLowerCase();
  if (!issue_id) return { ok: false, error: 'Missing issue.' };

  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  switch (action) {
    case 'assign':
      patch = { assignee: assignee || null, assigned_via: assignee ? 'manual' : null, assigned_at: assignee ? now : null };
      break;
    case 'start':
      patch = { status: 'in_progress' };
      break;
    case 'resolve':
      if (!note) return { ok: false, error: 'Say what was done — the next person reads it.' };
      patch = { status: 'resolved', resolved_at: now, resolved_by: user.email, resolution: note };
      break;
    case 'dismiss':
      if (!note) return { ok: false, error: 'Say why this is not an issue.' };
      patch = { status: 'dismissed', resolved_at: now, resolved_by: user.email, resolution: note };
      break;
    case 'reopen':
      patch = { status: 'open', resolved_at: null, resolved_by: null, resolution: null };
      break;
    default:
      return { ok: false, error: 'Unknown action.' };
  }

  const supabase = await createClient();
  const { error } = await supabase.from('sd_issue').update({ ...patch, updated_at: now }).eq('id', issue_id);
  if (error) return { ok: false, error: error.message };
  if (note && action !== 'resolve' && action !== 'dismiss') {
    await supabase.from('sd_issue_message').insert({ issue_id, author_email: user.email, body: note });
  }
  touch();
  return { ok: true };
}

/** Admin: set who a category routes to. */
export async function saveIssueRoute(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Not signed in.' };
  if (user.role !== 'admin') return { ok: false, error: 'Only an admin can change routing.' };
  const category = String(formData.get('category') ?? '').trim();
  const assignee = String(formData.get('assignee') ?? '').trim().toLowerCase() || null;
  if (!isCategory(category)) return { ok: false, error: 'Unknown category.' };
  const supabase = await createClient();
  const { error } = await supabase
    .from('sd_issue_route')
    .update({ assignee, updated_by: user.email, updated_at: new Date().toISOString() })
    .eq('category', category);
  if (error) return { ok: false, error: error.message };
  touch();
  return { ok: true, message: assignee ? `${category} issues now route to ${assignee}.` : `${category} issues are no longer routed.` };
}

/** The thread under an issue. */
export async function getIssueThread(issueId: number): Promise<{ messages: IssueMessage[] }> {
  const user = await currentUser();
  if (!user || !issueId) return { messages: [] };
  const supabase = await createClient();
  const { data } = await supabase
    .from('sd_issue_message')
    .select('id, issue_id, author_email, body, created_at')
    .eq('issue_id', issueId) // paging-ok: one issue's thread, a few dozen messages at most
    .order('created_at');
  return { messages: (data ?? []) as IssueMessage[] };
}
