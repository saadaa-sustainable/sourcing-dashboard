/**
 * Cross-cutting helpers and types shared across the forms server-action domains.
 *
 * NOTE: this module intentionally has NO 'use server' directive. It may therefore
 * export types, consts and sync helpers (which a 'use server' module may not). The
 * domain modules under actions-modules/ import from here; the barrel re-exports the
 * types.
 */

import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';
import type { ApprovalEntity, SdStatus } from '../types';

export type ActionResult =
  | { ok: true; message?: string; id?: number }
  | { ok: false; error: string };

export const fail = (error: string): ActionResult => ({ ok: false, error });
export const done = (message?: string): ActionResult => ({ ok: true, message });

export async function supa() {
  if (!hasSupabaseEnv()) throw new Error('Supabase is not configured.');
  return createClient();
}

export async function writeLog(
  entityType: ApprovalEntity,
  entityId: string,
  entityLabel: string,
  fromStatus: SdStatus | null,
  toStatus: SdStatus,
  actorEmail: string,
  notes?: string,
) {
  // Audit is best effort: a failed log must never roll back the transition.
  try {
    const supabase = await supa();
    await supabase.from('sd_approval_log').insert({
      entity_type: entityType,
      entity_id: entityId,
      entity_label: entityLabel,
      from_status: fromStatus,
      to_status: toStatus,
      actor_email: actorEmail,
      notes: notes ?? null,
    });
  } catch (error) {
    console.error('sd_approval_log insert failed', error);
  }
}

/**
 * Record a vendor's committed delivery date into sd_vendor_commitment_log (item
 * 1). Append-only: the first commitment for a PO is the initial event; a later,
 * different date is logged as a REVISION (keeping the original `committed_date`),
 * so revision frequency is provable. A no-op when the date is unchanged or blank.
 * Best-effort — never rolls back the PO transition that triggered it.
 */
export async function recordCommitment(
  poRefNum: string | null | undefined,
  vendorCode: string | null | undefined,
  newDate: string | null | undefined,
  actorEmail: string,
) {
  if (!poRefNum || !newDate) return;
  try {
    const supabase = await supa();
    const { data: rows } = await supabase
      .from('sd_vendor_commitment_log')
      .select('committed_date, revised_date')
      .eq('po_ref_num', poRefNum)
      .order('id', { ascending: true });
    const events = (rows ?? []) as { committed_date: string; revised_date: string | null }[];
    const now = new Date().toISOString();
    if (!events.length) {
      await supabase.from('sd_vendor_commitment_log').insert({
        po_ref_num: poRefNum,
        vendor_code: vendorCode ?? null,
        committed_date: newDate,
        committed_at: now,
        logged_by: actorEmail,
      });
      return;
    }
    const latest = events[events.length - 1];
    const latestDate = latest.revised_date ?? latest.committed_date;
    if (latestDate === newDate) return; // unchanged — don't log a duplicate
    await supabase.from('sd_vendor_commitment_log').insert({
      po_ref_num: poRefNum,
      vendor_code: vendorCode ?? null,
      committed_date: events[0].committed_date, // keep the original
      revised_date: newDate,
      revised_at: now,
      logged_by: actorEmail,
    });
  } catch (error) {
    console.error('sd_vendor_commitment_log insert failed', error);
  }
}

/* ================================================================== */
/* Buying plan                                                         */
/* ================================================================== */

export function numOrNull(value: unknown) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Append an accepted FG rate to the history (sd_standard_cost_rate_history).
 * The latest history row per product is what the Buying Plan values from, so
 * every acceptance/sign-off records one. Best-effort: never fails the sign-off.
 */
export type LinkResult = { ok: true; token: string; expiresAt: string } | { ok: false; error: string };

/**
 * Generate a tokenized, expiring, single-use data-capture link for a PO's cutting
 * register. Expiry = min(created+30d, easycom_completed_at+15d) — the link doesn't
 * outlive the SLA window; 30d if the PO isn't completed yet (spec §2).
 */
export const dateOrNull = (v: unknown) =>
  /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;
export const textOrNull = (v: unknown) => {
  const s = String(v ?? '').trim();
  return s || null;
};

/** Read the PO Approval input fields out of a FormData into a table row. */
