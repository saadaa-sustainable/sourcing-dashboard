'use server';

import { revalidatePath } from 'next/cache';
import { context } from '@/lib/inward-plan-v2/server';
import { UUID, validDate } from '@/lib/inward-plan-v2/validation';
import type { Result } from '@/lib/inward-plan-v2/types';

export async function updateTracker(_previous: Result, form: FormData): Promise<Result> {
  try {
    const { db, role } = await context();
    if (role === 'viewer') throw new Error('Only team and admin users may update reports.');
    const text = (key: string) => String(form.get(key) ?? '').trim();
    const action = text('operation');
    const quantity = text('quantity');
    const version = text('version') || null;
    let error: { message: string } | null;
    if (action === 'report' || action === 'reconcile') {
      if (!/^\d+(\.\d{1,3})?$/.test(quantity) || !Number.isFinite(Number(quantity)) ||
        (action === 'reconcile' && Number(quantity) <= 0)) throw new Error('Use a valid quantity with at most 3 decimal places.');
    }
    if (action === 'report') {
      if (!UUID.test(text('line_id'))) throw new Error('Invalid plan line.');
      const date = text('received_on');
      const followUp = text('follow_up_on');
      if ((Number(quantity) > 0 && !validDate(date)) || (date && !validDate(date)) ||
        (followUp && !validDate(followUp))) throw new Error('Enter valid receipt and follow-up dates.');
      if (text('reason').length > 4000 || text('remarks').length > 4000) throw new Error('Remarks must be at most 4000 characters.');
      ({ error } = await db.rpc('sd_inward_v2_report_grn', {
        p_line: text('line_id'), p_quantity: quantity, p_received_on: date || null,
        p_reason: text('reason'), p_follow_up: followUp || null, p_remarks: text('remarks'), p_version: version,
      }));
    } else if (action === 'reconcile') {
      if (!UUID.test(text('tracker_id')) || !/^[1-9][0-9]*$/.test(text('grn_detail_id')))
        throw new Error('Select a specific real system GRN detail.');
      ({ error } = await db.rpc('sd_inward_v2_reconcile_grn', {
        p_tracker: text('tracker_id'), p_grn_detail: text('grn_detail_id'), p_quantity: quantity, p_version: version,
      }));
    } else if (action === 'reverse') {
      if (!UUID.test(text('reconciliation_id')) || !text('reason') || text('reason').length > 4000)
        throw new Error('A valid reconciliation and a reversal reason are required.');
      ({ error } = await db.rpc('sd_inward_v2_reverse_grn', {
        p_id: text('reconciliation_id'), p_reason: text('reason'), p_version: version,
      }));
    } else throw new Error('Invalid tracker operation.');
    if (error) throw new Error(error.message);
    revalidatePath('/inward-plan-v2');
    revalidatePath('/inward-plan-v2/analytics');
    revalidatePath('/inward-plan-v2/grn-delay-tracker');
    return { ok: true, message: action === 'report' ? 'Physical receipt report saved. System actuals are unchanged.'
      : action === 'reconcile' ? 'Specific GRN quantity reconciled and audited.' : 'Reconciliation reversed and audited.' };
  } catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'Request failed.' }; }
}
