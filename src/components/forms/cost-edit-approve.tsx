'use client';

import { useState, useTransition } from 'react';
import { PencilLine } from 'lucide-react';
import { editAndApproveCost } from '@/lib/forms/actions';
import { canEditApproveCost } from '@/lib/forms/cost';
import { reloadWithToast, toastError } from '@/lib/toast';
import type { SdRole } from '@/lib/forms/types';

/**
 * Edit & approve for a cost awaiting the admin (a proposal or a submitted vendor rate): change
 * the rates and approve in one step. Saved as "Edited & Approved" (approval workflow spec).
 */
export function CostEditApprove({
  cost,
  track,
  role,
  small = false,
}: {
  cost: { id: number; neg_stage: string | null; job_cost: number | null; fob_cost: number | null; efob_cost: number | null; frozen?: boolean | null };
  track: 'fg' | 'material';
  role: SdRole;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [vals, setVals] = useState({
    job_cost: cost.job_cost?.toString() ?? '',
    fob_cost: cost.fob_cost?.toString() ?? '',
    efob_cost: cost.efob_cost?.toString() ?? '',
  });
  const [note, setNote] = useState('');
  const [pending, start] = useTransition();
  if (cost.frozen || !canEditApproveCost(role, cost.neg_stage)) return null;

  const labels = track === 'material'
    ? { job_cost: 'FOB Fabric', fob_cost: 'Billing', efob_cost: 'Standard Fabric' }
    : { job_cost: 'Job', fob_cost: 'FOB', efob_cost: 'E-FOB' };
  const btn = `wf-btn wf-btn-ghost${small ? ' wf-btn-sm' : ''}`;

  function save() {
    const fd = new FormData();
    fd.set('track', track);
    fd.set('id', String(cost.id));
    (Object.keys(vals) as (keyof typeof vals)[]).forEach((k) => fd.set(k, vals[k]));
    fd.set('note', note);
    start(async () => {
      const r = await editAndApproveCost(fd);
      if (r.ok) reloadWithToast(r.message ?? 'Edited & Approved.');
      else toastError(r.error);
    });
  }

  if (!open) {
    return (
      <button type="button" className={btn} disabled={pending} onClick={() => setOpen(true)} title="Change the rates and approve in one step">
        <PencilLine size={small ? 13 : 15} /> Edit &amp; approve
      </button>
    );
  }
  return (
    <div className="wf-cost-edit-approve" role="group" aria-label="Edit the rates and approve">
      {(Object.keys(labels) as (keyof typeof labels)[]).map((k) => (
        <label key={k}>
          {labels[k]} (₹)
          <input type="number" min={0} step="0.01" value={vals[k]} onChange={(e) => setVals((v) => ({ ...v, [k]: e.target.value }))} />
        </label>
      ))}
      <label className="wide">
        Comment (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Recorded with the approval" />
      </label>
      <div className="wf-cost-edit-approve-actions">
        <button type="button" className={`wf-btn wf-btn-primary${small ? ' wf-btn-sm' : ''}`} disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save & approve'}
        </button>
        <button type="button" className={btn} disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
