'use client';

import { useState, useTransition } from 'react';
import { Check, RotateCcw, X } from 'lucide-react';
import { reloadWithToast } from '@/lib/toast';
import {
  acceptProposedCost,
  confirmCmRate,
  confirmFabricRate,
  rejectCost,
  renegotiateCost,
  setTargetCost,
  signOffCost,
  type ActionResult,
} from '@/lib/forms/actions';
import {
  COST_STAGE_LABEL,
  COST_STAGE_TONE,
  canAcceptProposal,
  canConfirmCm,
  canConfirmFabric,
  canRejectCost,
  canRenegotiate,
  canSetTarget,
  canSignOff,
  targetSummary,
  type RateKey,
} from '@/lib/forms/cost';
import { TargetInputs, targetFields } from '@/components/forms/target-inputs';
import type { CostDecisionRecord, SdRole } from '@/lib/forms/types';

const disp = (v: number | null | undefined) => (v == null ? '—' : String(v));

/**
 * The approver's decision on a cost — accept the proposal, set a target, sign off
 * (fabric first, then CMTP, for finished goods), renegotiate or reject. Used on the
 * product page and on the Approvals queue card alike, so the approver decides where
 * they are standing rather than opening every product one by one. Renders nothing
 * when the signed-in role has no decision to make at the current stage.
 */
export function CostDecisionBar({
  cost,
  role,
  track,
  compact = false,
}: {
  cost: CostDecisionRecord;
  role: SdRole;
  track: 'fg' | 'material';
  /** On a queue card: no heading, the card already says what it is. */
  compact?: boolean;
}) {
  const isMat = track === 'material';
  const stage = cost.neg_stage ?? null;
  const [targets, setTargets] = useState<Partial<Record<RateKey, string>>>({});
  const [noteMode, setNoteMode] = useState<null | 'reject' | 'renegotiate'>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const canDecide =
    canSetTarget(role, stage) || canSignOff(role, stage) || canRejectCost(role, stage) || canRenegotiate(role, stage);
  if (!canDecide) return null;

  function act(action: (fd: FormData) => Promise<ActionResult>, extra: Record<string, string>) {
    setErr(null);
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    Object.entries(extra).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setErr(res.error);
    });
  }

  const labels = isMat
    ? { job: 'FOB Fabric', fob: 'Billing', efob: 'Standard Fabric' }
    : { job: 'Job', fob: 'FOB', efob: 'E-FOB' };
  const rates = [
    [labels.job, cost.job_cost],
    [labels.fob, cost.fob_cost],
    [labels.efob, cost.efob_cost],
  ]
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k} ${disp(v as number | null)}`)
    .join(' · ');
  const fabricDone = !!cost.fabric_confirmed_at;
  const cmDone = !!cost.cm_confirmed_at;
  const hasRate = cost.job_cost != null || cost.fob_cost != null || cost.efob_cost != null;

  const actions = noteMode ? (
    <div className="wf-approval-bar">
      <textarea
        className="wf-textarea"
        rows={2}
        placeholder={noteMode === 'reject' ? 'Reason for rejection — sent to the team' : 'What should change — sent to the team'}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="wf-approval-actions">
        <button
          type="button"
          className={noteMode === 'reject' ? 'wf-btn wf-btn-danger' : 'wf-btn wf-btn-primary'}
          disabled={busy || !note.trim()}
          onClick={() => act(noteMode === 'reject' ? rejectCost : renegotiateCost, { note })}
        >
          {busy ? 'Working…' : noteMode === 'reject' ? 'Confirm reject' : 'Confirm renegotiate'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost" onClick={() => { setNoteMode(null); setNote(''); }}>
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <div className="wf-approval-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
      {canAcceptProposal(role, stage) && (
        <button
          type="button"
          className="wf-btn wf-btn-primary"
          disabled={busy || !hasRate}
          title={hasRate ? 'The proposed rates become the standard cost' : 'The proposal names no rate — set a target instead'}
          onClick={() => act(acceptProposedCost, {})}
        >
          <Check size={15} /> {busy ? 'Working…' : 'Accept proposal'}
        </button>
      )}
      {canSetTarget(role, stage) && (
        <span className="wf-inline-actions">
          <TargetInputs cost={cost} track={track} value={targets} onChange={setTargets} disabled={busy} />
          <button
            type="button"
            className="wf-btn wf-btn-ghost"
            disabled={busy || !Object.keys(targetFields(targets)).length}
            onClick={() => act(setTargetCost, targetFields(targets))}
          >
            Set target
          </button>
        </span>
      )}
      {canSignOff(role, stage) &&
        (isMat ? (
          <button type="button" className="wf-btn wf-btn-primary" disabled={busy} onClick={() => act(signOffCost, {})}>
            <Check size={15} /> {busy ? 'Working…' : 'Sign off'}
          </button>
        ) : canConfirmFabric(role, stage, fabricDone) ? (
          <button type="button" className="wf-btn wf-btn-primary" disabled={busy} onClick={() => act(confirmFabricRate, {})}>
            <Check size={15} /> {busy ? 'Working…' : '1 · Confirm fabric rate'}
          </button>
        ) : canConfirmCm(role, stage, fabricDone, cmDone) ? (
          <button type="button" className="wf-btn wf-btn-primary" disabled={busy} onClick={() => act(confirmCmRate, {})}>
            <Check size={15} /> {busy ? 'Working…' : '2 · Confirm CMTP → sign off'}
          </button>
        ) : null)}
      {!isMat && fabricDone && !cmDone && <span className="wf-tag-approved">fabric ✓</span>}
      {canRenegotiate(role, stage) && (
        <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setNoteMode('renegotiate')}>
          <RotateCcw size={15} /> Renegotiate
        </button>
      )}
      {canRejectCost(role, stage) && (
        <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setNoteMode('reject')}>
          <X size={15} /> Reject
        </button>
      )}
    </div>
  );

  if (compact) {
    return (
      <div className="sc-decision-compact">
        {err && <p className="wf-inline-error">{err}</p>}
        {actions}
      </div>
    );
  }

  return (
    <section className="wf-queue-card wf-queue-card-wide sc-decision" aria-label="Your decision">
      <div className="wf-queue-head">
        <div>
          <h3>Your decision</h3>
          <p className="wf-subtle">
            {stage === 'proposed'
              ? `The team proposed ${rates || 'a rate'}${cost.proposed_cost != null ? ` (expected ${disp(cost.proposed_cost)})` : ''}. Accept it as-is and it becomes the standard cost; set a target and the team comes back with the actual vendor rate; or reject it with a reason.`
              : stage === 'rate_submitted'
                ? `The team submitted the actual vendor rate${rates ? ` — ${rates}` : ''}${targetSummary(cost, track) ? ` against your target of ${targetSummary(cost, track)}` : ''}. ${isMat ? 'Sign off to make it the standard cost' : 'Confirm the fabric rate, then the CMTP, and it becomes the standard cost'}; or send it back to renegotiate, or reject it. A new target sends it back to the team.`
                : stage === 'target_set' || stage === 'renegotiate'
                  ? `Waiting for the team's vendor rate${targetSummary(cost, track) ? ` against your target of ${targetSummary(cost, track)}` : ''}. You can change the target for any rate type; the team is notified.`
                  : stage === 'signed_off'
                    ? 'Signed off. Setting a new target starts a new round: the team comes back with a new vendor rate, and the current standard stays in use until that is signed off.'
                    : 'No proposal yet. You can set a target for any rate type now; the team is notified and comes back with the vendor rate.'}
          </p>
        </div>
        <span className={`wf-status tone-${COST_STAGE_TONE[stage ?? ''] ?? 'purple'}`}>{COST_STAGE_LABEL[stage ?? ''] ?? '—'}</span>
      </div>
      {err && <p className="wf-inline-error">{err}</p>}
      {actions}
    </section>
  );
}
