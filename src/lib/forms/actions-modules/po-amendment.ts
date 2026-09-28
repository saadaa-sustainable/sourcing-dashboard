'use server';

import { revalidatePath } from 'next/cache';
import { currentUser } from '../queries';
import { canEdit, statusOnSubmit } from '../approval';
import { istToday } from '@/lib/business-logic';
import type { PoAmendmentType } from '../types';
import { type ActionResult, fail, done, supa, writeLog, dateOrNull, textOrNull } from './_shared';

const TYPES: PoAmendmentType[] = ['cost', 'quantity', 'time'];
const TYPE_WORD: Record<PoAmendmentType, string> = { cost: 'cost', quantity: 'quantity', time: 'time' };

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

  const poRef = String(formData.get('po_ref_num') ?? '').trim();
  const type = String(formData.get('amendment_type') ?? '').trim() as PoAmendmentType;
  const reason = String(formData.get('reason') ?? '').trim();
  const agreedOn = dateOrNull(formData.get('agreed_with_vendor_on'));
  const evidence = textOrNull(formData.get('evidence_url'));

  if (!poRef) return fail('Pick the issued PO.');
  if (!TYPES.includes(type)) return fail('Pick what is being amended: cost, quantity or time.');
  if (!reason) return fail('The reason for the amendment is required.');
  if (!agreedOn) return fail('Enter the day this change was agreed with the vendor.');

  // Finance accepts an amendment only when it was entered on the day it was agreed.
  const today = istToday().toISOString().slice(0, 10);
  if (agreedOn !== today) {
    return fail(
      `Finance accepts an amendment only when it is recorded on the day it was agreed with the vendor. ` +
        `Today is ${today}; this one says ${agreedOn}. If it was agreed today, set the date to today.`,
    );
  }

  const supabase = await supa();
  // The PO as it stands in EasyEcom right now — one aggregated row.
  const { data: poRaw } = await supabase.rpc('sd_issued_pos').eq('po_ref_num', poRef).maybeSingle();
  const po = poRaw as {
    po_ref_num: string; po_number: string | null; vendor_code: string | null; vendor_name: string | null;
    product_codes: string | null; ordered_qty: number | null; pending_qty: number | null; rate: number | null;
    expected_delivery_date: string | null;
  } | null;
  if (!po) return fail(`${poRef} is not an open PO in EasyEcom. Amendments are raised only against issued POs.`);

  const orderedQty = Number(po.ordered_qty) || 0;
  const pendingQty = Number(po.pending_qty) || 0;
  const received = Math.max(0, orderedQty - pendingQty);
  const currentRate = po.rate == null ? null : Number(po.rate);

  const row: Record<string, unknown> = {
    po_ref_num: po.po_ref_num,
    po_number: po.po_number,
    vendor_code: po.vendor_code,
    vendor_name: po.vendor_name,
    product_codes: po.product_codes,
    amendment_type: type,
    agreed_with_vendor_on: agreedOn,
    reason,
    evidence_url: evidence,
    requested_by: user.email,
    requested_at: new Date().toISOString(),
  };
  let change = '';

  if (type === 'cost') {
    const newRate = Number(String(formData.get('new_rate') ?? '').trim());
    if (!(newRate > 0)) return fail('Enter the new rate per piece.');
    if (currentRate != null && Math.abs(newRate - currentRate) < 0.005) {
      return fail(`The PO already carries ₹${currentRate} per piece — nothing to amend.`);
    }
    row.current_rate = currentRate;
    row.new_rate = newRate;
    change = `rate ${currentRate == null ? '—' : `₹${currentRate}`} → ₹${newRate}`;
  } else if (type === 'quantity') {
    const newQty = Number(String(formData.get('new_qty') ?? '').trim());
    if (!Number.isInteger(newQty) || newQty < 0) return fail('Enter the new quantity in whole pieces.');
    if (newQty === orderedQty) return fail(`The PO is already for ${orderedQty} pieces — nothing to amend.`);
    if (newQty < received) {
      return fail(`${received} pieces have already been received on this PO; the quantity cannot go below that.`);
    }
    row.current_qty = orderedQty;
    row.new_qty = newQty;
    change = `quantity ${orderedQty} → ${newQty} pcs`;
  } else {
    const newDate = dateOrNull(formData.get('new_delivery_date'));
    if (!newDate) return fail('Enter the new delivery date.');
    if (po.expected_delivery_date && newDate === po.expected_delivery_date) {
      return fail(`The PO already expects delivery on ${newDate} — nothing to amend.`);
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
  row.status = status;

  const { data, error } = await supabase.from('sd_po_amendment').insert(row).select('id').single();
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
