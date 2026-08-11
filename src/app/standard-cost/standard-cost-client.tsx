'use client';

import { useMemo, useState, useTransition } from 'react';
import { Lock, Save, Send } from 'lucide-react';
import {
  saveMaterialCost,
  saveStandardCost,
  submitMaterialCost,
  submitStandardCost,
} from '@/lib/forms/actions';
import { canApprove, canEdit, canSubmit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import type { SdRole, StandardCost } from '@/lib/forms/types';

export function StandardCostClient({
  costs,
  role,
  track = 'fg',
}: {
  costs: StandardCost[];
  role: SdRole;
  track?: 'fg' | 'material';
}) {
  const isMat = track === 'material';
  const saveAction = isMat ? saveMaterialCost : saveStandardCost;
  const submitAction = isMat ? submitMaterialCost : submitStandardCost;
  const codeLabel = isMat ? 'Material code' : 'Product code';
  const fobLabel = isMat ? 'Purchase cost' : 'FOB cost';

  const editable = canEdit(role, 'draft');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState({ product_code: '', job_cost: '', fob_cost: '', efob_cost: '' });

  const approved = costs.filter((c) => c.status === 'approved').length;

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? costs.filter((c) => c.product_code.toLowerCase().includes(q)) : costs;
  }, [costs, filter]);

  function run(payload: FormData, action: typeof saveStandardCost) {
    setError(null);
    setMessage(null);
    start(async () => {
      const result = await action(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Saved.');
        window.location.reload();
      } else {
        setError(result.error);
      }
    });
  }

  function addCost() {
    if (!draft.product_code.trim()) {
      setError(`Enter a ${codeLabel.toLowerCase()}.`);
      return;
    }
    const fd = new FormData();
    fd.set('product_code', draft.product_code.trim());
    fd.set('job_cost', draft.job_cost);
    fd.set('fob_cost', draft.fob_cost);
    if (!isMat) fd.set('efob_cost', draft.efob_cost);
    run(fd, saveAction);
  }

  return (
    <>
      <Notice tone="info">
        {approved} of {costs.length} {isMat ? 'materials' : 'products'} have an approved
        standard cost. The Buying Plan multiplies each{' '}
        {isMat ? 'Job Work / Purchase' : 'PO-type'} quantity by its own rate.
        {isMat
          ? ' Job Work is a service (e.g. dyeing); Purchase buys the material outright.'
          : ' Rates freeze once a PO is issued for the product.'}
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="wf-form-panel">
          <div className="wf-form-grid">
            <Field label={codeLabel} hint="Add a code not already listed">
              <input
                value={draft.product_code}
                placeholder={isMat ? 'e.g. TRM07' : 'e.g. SDRPT'}
                onChange={(e) => setDraft({ ...draft, product_code: e.target.value })}
              />
            </Field>
            <Field label={isMat ? 'Job Work cost' : 'Job cost'}>
              <input
                type="number"
                min={0}
                value={draft.job_cost}
                onChange={(e) => setDraft({ ...draft, job_cost: e.target.value })}
              />
            </Field>
            <Field label={fobLabel}>
              <input
                type="number"
                min={0}
                value={draft.fob_cost}
                onChange={(e) => setDraft({ ...draft, fob_cost: e.target.value })}
              />
            </Field>
            {!isMat && (
              <Field label="E-FOB cost">
                <input
                  type="number"
                  min={0}
                  value={draft.efob_cost}
                  onChange={(e) => setDraft({ ...draft, efob_cost: e.target.value })}
                />
              </Field>
            )}
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={addCost}
              disabled={pending}
            >
              <Save size={15} /> Add / update
            </button>
          </div>
        </div>
      )}

      <div className="wf-toolbar">
        <input
          className="wf-search"
          placeholder="Filter product code…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="wf-subtle">{shown.length} shown</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>{codeLabel}</th>
                <th className="num input-col">{isMat ? 'Job Work cost' : 'Job cost'}</th>
                <th className="num input-col">{fobLabel}</th>
                {!isMat && <th className="num input-col">E-FOB cost</th>}
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((cost) => (
                <CostRow
                  key={cost.product_code}
                  cost={cost}
                  role={role}
                  pending={pending}
                  track={track}
                  onSave={(fd) => run(fd, saveAction)}
                  onSubmit={(fd) => run(fd, submitAction)}
                />
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={isMat ? 5 : 6} className="wf-empty-cell">
                    No {isMat ? 'materials' : 'products'} match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function CostRow({
  cost,
  role,
  pending,
  track,
  onSave,
  onSubmit,
}: {
  cost: StandardCost;
  role: SdRole;
  pending: boolean;
  track: 'fg' | 'material';
  onSave: (fd: FormData) => void;
  onSubmit: (fd: FormData) => void;
}) {
  const isMat = track === 'material';
  const [job, setJob] = useState(cost.job_cost?.toString() ?? '');
  const [fob, setFob] = useState(cost.fob_cost?.toString() ?? '');
  const [efob, setEfob] = useState(cost.efob_cost?.toString() ?? '');

  const rowEditable = !cost.frozen && canEdit(role, cost.status);
  const dirty =
    job !== (cost.job_cost?.toString() ?? '') ||
    fob !== (cost.fob_cost?.toString() ?? '') ||
    (!isMat && efob !== (cost.efob_cost?.toString() ?? ''));

  const save = () => {
    const fd = new FormData();
    fd.set('product_code', cost.product_code);
    fd.set('job_cost', job);
    fd.set('fob_cost', fob);
    if (!isMat) fd.set('efob_cost', efob);
    onSave(fd);
  };
  const submit = () => {
    const fd = new FormData();
    fd.set('id', String(cost.id));
    onSubmit(fd);
  };

  const cell = (value: string, set: (v: string) => void) =>
    rowEditable ? (
      <input type="number" min={0} value={value} onChange={(e) => set(e.target.value)} />
    ) : (
      <span>{value === '' ? '—' : value}</span>
    );

  return (
    <tr>
      <td className="mono">
        {cost.product_code}
        {cost.frozen && (
          <small className="wf-subtle">
            <Lock size={11} /> frozen
          </small>
        )}
      </td>
      <td className="num input-col">{cell(job, setJob)}</td>
      <td className="num input-col">{cell(fob, setFob)}</td>
      {!isMat && <td className="num input-col">{cell(efob, setEfob)}</td>}
      <td>
        <StatusBadge status={cost.status} />
        {cost.status === 'rejected' && cost.rejection_notes && (
          <small className="wf-subtle">{cost.rejection_notes}</small>
        )}
      </td>
      <td>
        <div className="wf-issue-row">
          {rowEditable && (
            <button
              type="button"
              className="wf-btn wf-btn-ghost wf-btn-sm"
              disabled={!dirty || pending}
              onClick={save}
            >
              <Save size={13} /> Save
            </button>
          )}
          {cost.status === 'draft' && canSubmit(role, cost.status) && !cost.frozen && (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              disabled={pending || dirty}
              title={dirty ? 'Save your changes first' : undefined}
              onClick={submit}
            >
              <Send size={13} /> Submit
            </button>
          )}
          {(cost.status === 'submitted' || cost.status === 'pending_l2') &&
            (canApprove(role, cost.status) ? (
              <ApprovalBar
                entityType={isMat ? 'material_cost' : 'standard_cost'}
                entityId={String(cost.id)}
                entityLabel={`${isMat ? 'Material' : 'Standard'} cost — ${cost.product_code}`}
                onDone={(res) => {
                  if (res.ok) window.location.reload();
                }}
              />
            ) : (
              <span className="wf-subtle">Awaiting approval</span>
            ))}
        </div>
      </td>
    </tr>
  );
}
