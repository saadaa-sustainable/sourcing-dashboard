'use server';

import { currentUser } from '@/lib/forms/queries';
import { supa } from '@/lib/forms/actions-modules/_shared';

type SaveFgWorkflowInput = {
  requestPayload: Record<string, unknown>;
  tableName: 'fg_merchandise_submissions' | 'fg_accounts_submissions';
  submissionPayload: Record<string, unknown>;
};

type FounderDecisionInput = {
  requestId: number;
  poRefNum: string | null;
  poId: number | null;
  poNumber: number | null;
  decision: 'Approved' | 'Rejected';
  decisionRemarks: string | null;
  merchandiseSnapshot: Record<string, unknown>;
  accountsSnapshot: Record<string, unknown>;
  poSnapshot: Record<string, unknown>;
  status: 'Closed' | 'Ready for closer';
};

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const value = error as Record<string, unknown>;
    const message = String(value.message ?? '').trim();
    const details = String(value.details ?? '').trim();
    const hint = String(value.hint ?? '').trim();
    const code = String(value.code ?? '').trim();
    return [message, details, hint, code ? `Code: ${code}` : '']
      .filter(Boolean)
      .join(' | ') || fallback;
  }
  return error instanceof Error ? error.message : fallback;
}

export async function saveFgWorkflowSubmission(
  input: SaveFgWorkflowInput,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Your session has expired. Please sign in again.' };

  try {
    const db = await supa();

    const { data: requestRow, error: upsertError } = await db
      .schema('FG Closer')
      .from('fg_po_closure_requests')
      .upsert(input.requestPayload, { onConflict: 'po_id' })
      .select('id')
      .single();

    if (upsertError) {
      throw new Error(errorMessage(upsertError, 'Failed to save the FG closure request.'));
    }

    const requestId = Number(requestRow?.id);
    if (!Number.isFinite(requestId)) {
      throw new Error('Closure request ID was not returned after saving the workflow.');
    }

    const { data: previousSubmissions, error: revisionError } = await db
      .schema('FG Closer')
      .from(input.tableName)
      .select('id')
      .eq('request_id', requestId);

    if (revisionError) {
      throw new Error(errorMessage(revisionError, 'Failed to read the previous review revisions.'));
    }

    const submissionPayload = {
      ...input.submissionPayload,
      request_id: requestId,
      revision_no: (previousSubmissions?.length ?? 0) + 1,
    };

    const { error: submissionError } = await db
      .schema('FG Closer')
      .from(input.tableName)
      .insert(submissionPayload);

    if (submissionError) {
      throw new Error(errorMessage(submissionError, 'Failed to save the department review.'));
    }

    return {
      ok: true,
      message:
        input.tableName === 'fg_merchandise_submissions'
          ? 'Merchandise review saved. PO has been moved to Accounts Review.'
          : 'Accounts review saved. PO has been moved to Founder Review.',
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to save the FG closure review.') };
  }
}


type SendFgPoToL2Input = {
  requestId: number;
};

export async function sendFgPoToL2(
  input: SendFgPoToL2Input,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Your session has expired. Please sign in again.' };

  try {
    const requestId = Number(input.requestId);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new Error('A valid FG closure request ID is required.');
    }

    const db = await supa();

    // Confirm that both departments have submitted at least one review revision.
    const [{ data: merchandise, error: merchandiseError }, { data: accounts, error: accountsError }] =
      await Promise.all([
        db
          .schema('FG Closer')
          .from('fg_merchandise_submissions')
          .select('id')
          .eq('request_id', requestId)
          .order('revision_no', { ascending: false })
          .limit(1)
          .maybeSingle(),
        db
          .schema('FG Closer')
          .from('fg_accounts_submissions')
          .select('id')
          .eq('request_id', requestId)
          .order('revision_no', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    if (merchandiseError) {
      throw new Error(errorMessage(merchandiseError, 'Failed to verify the Merchandise submission.'));
    }
    if (accountsError) {
      throw new Error(errorMessage(accountsError, 'Failed to verify the Accounts submission.'));
    }
    if (!merchandise || !accounts) {
      throw new Error('Both Merchandise and Accounts submissions are required before sending this PO to L-2.');
    }

    // Only an L-1 request can be transitioned. This prevents accidental
    // status changes if the user double-clicks or the workflow has moved on.
    const { data: updatedRequest, error: updateError } = await db
      .schema('FG Closer')
      .from('fg_po_closure_requests')
      .update({ status: 'L-2', updated_at: new Date().toISOString() })
      .eq('id', requestId)
      .eq('status', 'L-1')
      .select('id')
      .maybeSingle();

    if (updateError) {
      throw new Error(errorMessage(updateError, 'Failed to update the FG PO workflow status to L-2.'));
    }
    if (!updatedRequest) {
      throw new Error('This PO is no longer in L-1. Refresh the dashboard and try again.');
    }

    return { ok: true, message: 'PO successfully sent to L-2.' };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to send the FG PO to L-2.') };
  }
}


type SendFgPoBackToL1Input = {
  requestId: number;
  poRefNum: string | null;
  poId: number | null;
  poNumber: number | null;
  decisionRemarks: string;
  merchandiseSnapshot: Record<string, unknown>;
  accountsSnapshot: Record<string, unknown>;
  poSnapshot: Record<string, unknown>;
};

/** Return an L-2 PO to L-1 while preserving the send-back decision in history. */
export async function sendFgPoBackToL1(
  input: SendFgPoBackToL1Input,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Your session has expired. Please sign in again.' };

  try {
    const requestId = Number(input.requestId);
    const reason = String(input.decisionRemarks ?? '').trim();
    if (!Number.isInteger(requestId) || requestId <= 0) {
      throw new Error('A valid FG closure request ID is required.');
    }
    if (!reason) throw new Error('Please enter a reason before sending this PO back to L-1.');

    const db = await supa();
    const { data: request, error: requestError } = await db
      .schema('FG Closer')
      .from('fg_po_closure_requests')
      .select('id, status')
      .eq('id', requestId)
      .maybeSingle();
    if (requestError) throw new Error(errorMessage(requestError, 'Failed to verify the current PO stage.'));
    if (!request || request.status !== 'L-2') {
      throw new Error('This PO is no longer in L-2. Refresh the dashboard and try again.');
    }

    const { data: previousDecisions, error: historyError } = await db
      .schema('FG Closer')
      .from('fg_founder_decisions')
      .select('revision_no')
      .eq('request_id', requestId)
      .order('revision_no', { ascending: false })
      .limit(1);
    if (historyError) throw new Error(errorMessage(historyError, 'Failed to read the previous L-2 decision history.'));

    const decidedAt = new Date().toISOString();
    const nextRevision = Number(previousDecisions?.[0]?.revision_no ?? 0) + 1;
    const { error: historyInsertError } = await db
      .schema('FG Closer')
      .from('fg_founder_decisions')
      .insert({
        request_id: requestId,
        po_ref_num: input.poRefNum,
        po_id: input.poId,
        po_number: input.poNumber,
        revision_no: nextRevision,
        decision: 'Rejected',
        decision_remarks: reason,
        decided_by_name: String(user.email ?? '').split('@')[0],
        decided_by_email: user.email,
        decided_at: decidedAt,
        merchandise_snapshot: input.merchandiseSnapshot,
        accounts_snapshot: input.accountsSnapshot,
        po_snapshot: input.poSnapshot,
      });
    if (historyInsertError) throw new Error(errorMessage(historyInsertError, 'Failed to save the L-2 send-back history.'));

    const { data: updatedRequest, error: updateError } = await db
      .schema('FG Closer')
      .from('fg_po_closure_requests')
      .update({
        status: 'L-1',
        founder_review: JSON.stringify({ send_back_reason: reason, sent_back_by: user.email, sent_back_at: decidedAt }),
        updated_at: decidedAt,
      })
      .eq('id', requestId)
      .eq('status', 'L-2')
      .select('id')
      .maybeSingle();
    if (updateError) throw new Error(errorMessage(updateError, 'Failed to return the PO to L-1.'));
    if (!updatedRequest) throw new Error('The PO stage changed while sending it back. Refresh the dashboard and try again.');

    return { ok: true, message: 'PO sent back to L-1. The L-2 send-back reason has been saved.' };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to send the FG PO back to L-1.') };
  }
}

export async function decideFgFounder(
  input: FounderDecisionInput,
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const user = await currentUser();
  if (!user) return { ok: false, error: 'Your session has expired. Please sign in again.' };

  try {
    const db = await supa();

    const [{ data: merch }, { data: accounts }] = await Promise.all([
      db
        .schema('FG Closer')
        .from('fg_merchandise_submissions')
        .select('*')
        .eq('request_id', input.requestId)
        .order('revision_no', { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .schema('FG Closer')
        .from('fg_accounts_submissions')
        .select('*')
        .eq('request_id', input.requestId)
        .order('revision_no', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const decidedAt = new Date().toISOString();

    const { error: founderInsertError } = await db
      .schema('FG Closer')
      .from('fg_founder_decisions')
      .insert({
        request_id: input.requestId,
        po_ref_num: input.poRefNum,
        po_id: input.poId,
        po_number: input.poNumber,
        revision_no: 1,
        decision: input.decision,
        decision_remarks: input.decisionRemarks,
        decided_by_name: String(user.email ?? '').split('@')[0],
        decided_by_email: user.email,
        decided_at: decidedAt,
        merchandise_snapshot: Object.keys(input.merchandiseSnapshot).length ? input.merchandiseSnapshot : (merch ?? {}),
        accounts_snapshot: Object.keys(input.accountsSnapshot).length ? input.accountsSnapshot : (accounts ?? {}),
        po_snapshot: input.poSnapshot,
      });

    if (founderInsertError) {
      throw new Error(errorMessage(founderInsertError, 'Failed to save the Founder decision.'));
    }

    const { error: updateError } = await db
      .schema('FG Closer')
      .from('fg_po_closure_requests')
      .update({
        status: input.status,
        founder_review: input.decisionRemarks,
        founder_approved_by: user.email,
        founder_approved_at: decidedAt,
        updated_at: decidedAt,
      })
      .eq('id', input.requestId);

    if (updateError) {
      throw new Error(errorMessage(updateError, 'Failed to update the Founder workflow status.'));
    }

    return {
      ok: true,
      message:
        input.decision === 'Approved'
          ? 'Final approval completed. PO is now Closed.'
          : 'Founder rejected the request. PO has been returned to Ready for closer.',
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error, 'Failed to complete the Founder decision.') };
  }
}
