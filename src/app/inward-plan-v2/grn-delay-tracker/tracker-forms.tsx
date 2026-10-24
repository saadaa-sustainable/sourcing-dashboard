'use client';

import { useActionState } from 'react';
import { updateTracker } from './actions';
import type { DelayReport, Reconciliation, SystemGrn } from '@/lib/inward-plan-v2/grn-types';
import type { PlanLine, Result } from '@/lib/inward-plan-v2/types';
import styles from '../v2.module.css';

function Form({ children }: { children: React.ReactNode }) {
  const [result, action, pending] = useActionState(updateTracker, { ok: false, message: '' } as Result);
  return <form action={action} className={styles.form}>
    <fieldset className={`${styles.fieldset} ${styles.trackerFields}`} disabled={pending}>{children}
      <button className="wf-btn wf-btn-primary" type="submit">{pending ? 'Saving…' : 'Save'}</button>
    </fieldset>
    {result.message && <p className={result.ok ? 'wf-notice wf-notice-ok' : 'wf-notice wf-notice-error'} role="status">{result.message}</p>}
  </form>;
}
export function ReportForm({ line, report, today }: { line: PlanLine; report?: DelayReport; today: string }) {
  return <Form>
    <input type="hidden" name="operation" value="report" />
    <input type="hidden" name="line_id" value={line.id} />
    <input type="hidden" name="version" value={report?.updated_at ?? ''} />
    <div className={styles.grid}>
      <label>Total quantity physically received<input className="wf-input" name="quantity" type="number" min="0" step="0.001" required defaultValue={report?.reported_qty ?? ''} /></label>
      <label>Physical receipt date<input className="wf-input" type="date" name="received_on" max={today} defaultValue={report?.received_on ?? ''} /></label>
      <label>Follow-up date<input className="wf-input" type="date" name="follow_up_on" defaultValue={report?.follow_up_on ?? ''} /></label>
    </div>
    <label>GRN delay reason<textarea className="wf-input" name="reason" rows={2} maxLength={4000} defaultValue={report?.delay_reason ?? ''} /></label>
    <label>Remarks<textarea className="wf-input" name="remarks" rows={2} maxLength={4000} defaultValue={report?.remarks ?? ''} /></label>
    <p className={styles.trackerHelp}>Enter the total reported physical quantity, not an incremental addition. Over-receipts may exceed the plan target. Zero clears an incorrect report after its reconciliations are reversed.</p>
  </Form>;
}
export function ReconcileForm({ report, receipts, sourceClaimed, awaiting }: {
  report: DelayReport; receipts: SystemGrn[]; sourceClaimed: [string, number][]; awaiting: number;
}) {
  const used = new Map(sourceClaimed);
  return <Form>
    <input type="hidden" name="operation" value="reconcile" />
    <input type="hidden" name="tracker_id" value={report.id} />
    <input type="hidden" name="version" value={report.updated_at} />
    <label>Specific matching system GRN detail<select name="grn_detail_id" className="wf-input" required defaultValue="">
      <option value="" disabled>Select a real GRN reference</option>
      {receipts.map(row => <option key={row.grn_detail_id} value={row.grn_detail_id}
        disabled={Number(row.received_qty) - (used.get(row.grn_detail_id) ?? 0) <= 0}>
        GRN {row.grn_id ?? '—'} / detail {row.grn_detail_id} · {row.received_on} · {row.sku} / {row.size ?? 'unknown size'} · available {Math.max(0, Number(row.received_qty) - (used.get(row.grn_detail_id) ?? 0))}
      </option>)}
    </select></label>
    <label>Quantity to reconcile<input className="wf-input" name="quantity" type="number" min="0.001" step="0.001" max={awaiting} required /></label>
    <p className={styles.muted}>Only the exact PO detail / PO / SKU / size qualifies. Partial reconciliation is supported. The server checks the latest tracker and GRN balances.</p>
  </Form>;
}
export function ReverseForm({ row, report }: { row: Reconciliation; report: DelayReport }) {
  return <Form>
    <input type="hidden" name="operation" value="reverse" />
    <input type="hidden" name="reconciliation_id" value={row.id} />
    <input type="hidden" name="version" value={report.updated_at} />
    <label>Reason for reversing GRN detail {row.grn_detail_id}
      <input name="reason" className="wf-input" required maxLength={4000} />
    </label>
  </Form>;
}
