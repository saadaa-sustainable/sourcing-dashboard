'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { canEdit, statusOnSubmit } from '../approval';
import { istToday } from '@/lib/business-logic';
import type { PoAmendmentType, SdStatus } from '../types';
import { type ActionResult, fail, done, supa, writeLog, dateOrNull, textOrNull } from './_shared';

const TYPES: PoAmendmentType[] = ['cost', 'quantity', 'time'];
const TYPE_WORD: Record<PoAmendmentType, string> = { cost: 'cost', quantity: 'quantity', time: 'time' };

type Supa = Awaited<ReturnType<typeof supa>>;
type AmendmentBuilt = {
  poRef: string;
  type: PoAmendmentType;
  reason: string;
  agreedOn: string;
  /** The row's PO-derived and user-entered fields, without the requester / status. */
  row: Record<string, unknown>;
  change: string;
  status: SdStatus;
};

/**
 * Read and check an amendment from a form, against the PO as EasyEcom shows it now. Shared by
 * raise and amend, so both apply the same checks (the PO must be open, the figure must move,
 * quantity cannot go below what has been received). The same-day rule is the caller's: a new
 * amendment is always checked, an amended one only when its agreement with the vendor changed.
 */
async function buildAmendment(
  supabase: Supa,
  formData: FormData,
): Promise<{ ok: true; a: AmendmentBuilt } | { ok: false; error: string }> {
  const bad = (error: string) => ({ ok: false as const, error });
  const poRef = String(formData.get('po_ref_num') ?? '').trim();
  const type = String(formData.get('amendment_type') ?? '').trim() as PoAmendmentType;
  const reason = String(formData.get('reason') ?? '').trim();
  const agreedOn = dateOrNull(formData.get('agreed_with_vendor_on'));
  const evidence = textOrNull(formData.get('evidence_url'));

  if (!poRef) return bad('Pick the issued PO.');
  if (!TYPES.includes(type)) return bad('Pick what is being amended: cost, quantity or time.');
  if (!reason) return bad('The reason for the amendment is required.');
  if (!agreedOn) return bad('Enter the day this change was agreed with the vendor.');

  // The PO as it stands in EasyEcom right now — one aggregated row.
  const { data: poRaw } = await supabase.rpc('sd_issued_pos').eq('po_ref_num', poRef).maybeSingle();
  const po = poRaw as {
    po_ref_num: string; po_number: string | null; vendor_code: string | null; vendor_name: string | null;
    product_codes: string | null; ordered_qty: number | null; pending_qty: number | null; rate: number | null;
    expected_delivery_date: string | null;
  } | null;
  if (!po) return bad(`${poRef} is not an open PO in EasyEcom. Amendments are raised only against issued POs.`);

  const orderedQty = Number(po.ordered_qty) || 0;
  const pendingQty = Number(po.pending_qty) || 0;
  const received = Math.max(0, orderedQty - pendingQty);
  const currentRate = po.rate == null ? null : Number(po.rate);

  // Every kind's figures are written, the unused ones blank, so an amendment that changes
  // kind does not keep the old kind's numbers.
  const row: Record<string, unknown> = {
    po_ref_num: po.po_ref_num,
    po_number: po.po_number,
    vendor_code: po.vendor_code,
    vendor_name: po.vendor_name,
    product_codes: po.product_codes,
    po_approval_id: null,
    amendment_type: type,
    current_rate: null,
    new_rate: null,
    current_qty: null,
    new_qty: null,
    current_delivery_date: null,
    new_delivery_date: null,
    agreed_with_vendor_on: agreedOn,
    reason,
    evidence_url: evidence,
  };
  let change = '';

  if (type === 'cost') {
    const newRate = Number(String(formData.get('new_rate') ?? '').trim());
    if (!(newRate > 0)) return bad('Enter the new rate per piece.');
    if (currentRate != null && Math.abs(newRate - currentRate) < 0.005) {
      return bad(`The PO already carries ₹${currentRate} per piece — nothing to amend.`);
    }
    row.current_rate = currentRate;
    row.new_rate = newRate;
    change = `rate ${currentRate == null ? '—' : `₹${currentRate}`} → ₹${newRate}`;
  } else if (type === 'quantity') {
    const newQty = Number(String(formData.get('new_qty') ?? '').trim());
    if (!Number.isInteger(newQty) || newQty < 0) return bad('Enter the new quantity in whole pieces.');
    if (newQty === orderedQty) return bad(`The PO is already for ${orderedQty} pieces — nothing to amend.`);
    if (newQty < received) {
      return bad(`${received} pieces have already been received on this PO; the quantity cannot go below that.`);
    }
    row.current_qty = orderedQty;
    row.new_qty = newQty;
    change = `quantity ${orderedQty} → ${newQty} pcs`;
  } else {
    const newDate = dateOrNull(formData.get('new_delivery_date'));
    if (!newDate) return bad('Enter the new delivery date.');
    if (po.expected_delivery_date && newDate === po.expected_delivery_date) {
      return bad(`The PO already expects delivery on ${newDate} — nothing to amend.`);
    }
    row.current_delivery_date = po.expected_delivery_date;
    row.new_delivery_date = newDate;
    change = `delivery ${po.expected_delivery_date ?? '—'} → ${newDate}`;
  }

  // The dashboard's own request behind this PO, when one matches — for the link and for
  // the route (an NPD / MAT PO is always a two-level approval, as at issue).
  let category: string | null = null;
  const { data: req } = await supabase
    .from('sd_po_approval')
    .select('id, category')
    .is('deleted_at', null)
    .or(`po_ref_num.eq.${poRef.replace(/[,()]/g, '')},easycom_po_no.eq.${(po.po_number ?? '').replace(/[,()]/g, '')}`)
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (req) {
    row.po_approval_id = Number(req.id);
    category = (req.category as string | null) ?? null;
  }

  const routeQty = type === 'quantity' ? Math.max(orderedQty, Number(row.new_qty)) : orderedQty;
  const status = statusOnSubmit('po_amendment', routeQty, category);
  return { ok: true, a: { poRef: po.po_ref_num, type, reason, agreedOn, row, change, status } };
}

/** Finance accepts an amendment only when it was entered on the day it was agreed. */
function sameDayError(agreedOn: string): string | null {
  const today = istToday().toISOString().slice(0, 10);
  if (agreedOn === today) return null;
  return (
    `Finance accepts an amendment only when it is recorded on the day it was agreed with the vendor. ` +
    `Today is ${today}; this one says ${agreedOn}. If it was agreed today, set the date to today.`
  );
}

/**
 * Raise an amendment to a PO that is already issued in EasyEcom (spec 7.9): a change of
 * cost, quantity or time, against the PO as the feed shows it now. The PO's current figure
 * is read here, not trusted from the form, so the approver compares like with like.
 *
 * Finance's rule is enforced as written: the change must be recorded the same day it was
 * agreed with the vendor, or it is refused. The request then takes the PO's own approval
 * route (quantity and category decide, as at issue).
 */
export async function createPoAmendment(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to raise a PO amendment.');

  const supabase = await supa();
  const built = await buildAmendment(supabase, formData);
  if (!built.ok) return fail(built.error);
  const { poRef, type, reason, row, change, status } = built.a;
  const late = sameDayError(built.a.agreedOn);
  if (late) return fail(late);

  const { data, error } = await supabase
    .from('sd_po_amendment')
    .insert({ ...row, status, requested_by: user.email, requested_at: new Date().toISOString() })
    .select('id')
    .single();
  if (error) {
    return fail(
      error.code === '23505'
        ? `A ${TYPE_WORD[type]} amendment for ${poRef} is already open. Wait for it to be decided, or ask the approver to send it back.`
        : error.message,
    );
  }

  const label = `PO amendment — ${poRef} · ${change}`;
  await writeLog('po_amendment', String(data.id), label, 'draft', status, user.email, reason);
  revalidatePath('/po-amendment');
  revalidatePath('/approvals');
  return done(`Amendment raised for ${poRef} (${change}) and sent for approval.`);
}

const LIVE: SdStatus[] = ['draft', 'submitted', 'pending_l2', 'rework'];

/**
 * Amend a PO amendment (team / admin). HOUSE RULE: until it is approved, every field can be
 * changed. A sent-back or rejected amendment goes back to the approval queue when amended; a
 * pending one stays pending (moving up to the admin when the new figures need it). The PO's
 * current figure is re-read from EasyEcom, and the received-quantity floor still applies.
 * Approved = locked.
 *
 * Finance's same-day rule: when the PO, the kind or the new figure changes, that is a new
 * agreement with the vendor, so its agreed date must be today. Correcting only the reason or
 * the evidence keeps the original agreed date.
 */
export async function updatePoAmendment(formData: FormData): Promise<ActionResult> {
  const user = await currentUser();
  if (!user) return fail('Not signed in.');
  if (!canEdit(user.role, 'draft')) return fail('You do not have permission to change a PO amendment.');
  const id = Number(formData.get('id'));
  if (!Number.isInteger(id) || id <= 0) return fail('Invalid amendment.');

  const supabase = await supa();
  const { data: oldRaw } = await supabase
    .from('sd_po_amendment')
    .select(
      'id, status, po_ref_num, amendment_type, new_rate, new_qty, new_delivery_date, agreed_with_vendor_on, reason, evidence_url',
    )
    .eq('id', id)
    .maybeSingle();
  if (!oldRaw) return fail('Amendment not found.');
  const old = oldRaw as Record<string, unknown>;
  const from = old.status as SdStatus;
  if (from === 'approved') {
    return fail('This amendment is approved, so it is locked. Ask the approver to reopen it to change it.');
  }

  const built = await buildAmendment(supabase, formData);
  if (!built.ok) return fail(built.error);
  const { poRef, type, row, change } = built.a;

  const str = (v: unknown) => (v == null ? '' : String(v));
  const num = (v: unknown) => (v == null || v === '' ? '' : String(Number(v)));
  const termsChanged =
    str(old.po_ref_num).trim().toUpperCase() !== poRef.trim().toUpperCase() ||
    old.amendment_type !== type ||
    num(old.new_rate) !== num(row.new_rate) ||
    num(old.new_qty) !== num(row.new_qty) ||
    str(old.new_delivery_date).slice(0, 10) !== str(row.new_delivery_date);
  const agreedChanged = str(old.agreed_with_vendor_on).slice(0, 10) !== built.a.agreedOn;
  if (termsChanged || agreedChanged) {
    const late = sameDayError(built.a.agreedOn);
    if (late) return fail(late);
  }

  const changes: string[] = [];
  if (termsChanged) changes.push(`now ${poRef} · ${change}`);
  if (agreedChanged) changes.push(`agreed on ${str(old.agreed_with_vendor_on).slice(0, 10) || '—'} → ${built.a.agreedOn}`);
  if (str(old.reason) !== str(row.reason)) changes.push('reason reworded');
  if (str(old.evidence_url) !== str(row.evidence_url)) changes.push(`evidence ${str(old.evidence_url) || '—'} → ${str(row.evidence_url) || '—'}`);
  if (!changes.length) return fail('Nothing was changed.');

  const resubmit = from === 'rework' || from === 'rejected' || from === 'draft';
  // Still pending: stays where it waits, but moves up to the admin when the new figures route there.
  const to: SdStatus = resubmit ? built.a.status : built.a.status === 'pending_l2' ? 'pending_l2' : from;

  // A rejected amendment is outside the one-open-amendment rule, so a newer one of the same kind
  // may have been raised since. Changing the PO or the kind can collide the same way.
  const { data: other } = await supabase
    .from('sd_po_amendment')
    .select('id, status')
    .neq('id', id)
    .in('status', LIVE)
    .ilike('po_ref_num', poRef.replace(/[%_\\]/g, (c) => `\\${c}`))
    .eq('amendment_type', type)
    .limit(1)
    .maybeSingle();
  if (other) {
    return fail(
      `A ${TYPE_WORD[type]} amendment for ${poRef} is already open (#${other.id}, ${String(other.status).replace('_', ' ')}). ` +
        'Amend that one instead.',
    );
  }

  const { data: saved, error } = await supabase
    .from('sd_po_amendment')
    .update({ ...row, status: to })
    .eq('id', id)
    .neq('status', 'approved')
    .select('id')
    .maybeSingle();
  if (error) {
    return fail(
      error.code === '23505'
        ? `A ${TYPE_WORD[type]} amendment for ${poRef} is already open. Amend that one instead.`
        : error.message,
    );
  }
  if (!saved) return fail('This amendment was approved meanwhile, so it is locked.');

  await writeLog(
    'po_amendment',
    String(id),
    `PO amendment — ${poRef} · ${change}`,
    from,
    to,
    user.email,
    `Amended: ${changes.join('; ')}${resubmit ? ' — resubmitted for approval' : ''}`,
  );
  revalidatePath('/po-amendment');
  revalidatePath('/approvals');
  return done(`Amendment for ${poRef} saved${resubmit ? ' and sent back for approval' : ''}.`);
}
