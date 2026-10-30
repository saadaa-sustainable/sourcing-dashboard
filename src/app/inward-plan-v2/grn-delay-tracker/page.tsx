import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Notice } from '@/components/forms/form-layout';
import { pageAll } from '@/lib/forms/queries-modules/_shared';
import { context, V2SignInRequired } from '@/lib/inward-plan-v2/server';
import { loadGrnData } from '@/lib/inward-plan-v2/grn-server';
import { matchingGrns, reconciliationBalances } from '@/lib/inward-plan-v2/analytics';
import { UUID } from '@/lib/inward-plan-v2/validation';
import type { HistoryEntry } from '@/lib/inward-plan-v2/types';
import { STATUS_LABEL } from '@/lib/inward-plan-v2/types';
import { ReportingShell } from '../reporting-shell';
import { ReconcileForm, ReportForm, ReverseForm } from './tracker-forms';
import styles from '../v2.module.css';

export const dynamic = 'force-dynamic';
const number = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const when = (date: string) => new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
export default async function TrackerPage({ searchParams }: { searchParams: Promise<{ line?: string; cadence?: string }> }) {
  const params = await searchParams;
  let access;
  try { access = await context(); } catch (error) {
    if (error instanceof V2SignInRequired) redirect('/login');
    return <ReportingShell section="tracker" title="V2 GRN Delay Tracker" role="viewer"><Notice tone="error">{error instanceof Error ? error.message : 'Access denied.'}</Notice></ReportingShell>;
  }
  const shell = (content: React.ReactNode) => <ReportingShell section="tracker" title="V2 GRN Delay Tracker"
    role={access.role} email={access.email} allowedPages={access.allowedPages}>{content}</ReportingShell>;
  if (params.line && !UUID.test(params.line)) notFound();
  if (params.cadence && !['weekly', 'monthly'].includes(params.cadence)) return shell(<Notice tone="error">Choose weekly or monthly.</Notice>);
  let data;
  let balances;
  try { data = await loadGrnData(); balances = reconciliationBalances(data); }
  catch (error) { return shell(<Notice tone="error">Tracker unavailable. {error instanceof Error ? error.message : ''}
    <p>Ensure all V2 migrations have been applied.</p></Notice>); }
  const plans = new Map(data.plans.map(plan => [plan.id, plan]));
  const selected = params.line ? data.lines.find(line => line.id === params.line) : null;
  if (params.line && !selected) notFound();
  const cadence = selected ? plans.get(selected.plan_id)!.period_kind : params.cadence ?? 'monthly';
  const rows = data.lines.filter(line => plans.get(line.plan_id)?.period_kind === cadence);
  const reports = new Map(data.reports.map(report => [report.line_id, report]));
  const report = selected ? reports.get(selected.id) : undefined;
  const plan = selected ? plans.get(selected.plan_id) : undefined;
  const editable = access.role !== 'viewer' && !!plan && (access.role === 'admin' || plan.created_by === access.email);
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  let history: HistoryEntry[] = [];
  if (selected) {
    try {
      history = (await pageAll<HistoryEntry>(() => access.db.from('sd_inward_plan_v2_approval_history').select('*')
        .eq('plan_id', selected.plan_id).in('entity', ['grn_delay', 'grn_reconciliation'])
        .order('changed_at', { ascending: false }).order('id', { ascending: false })))
        .filter(row => row.before_row?.line_id === selected.id || row.after_row?.line_id === selected.id);
    } catch (error) { return shell(<Notice tone="error">Audit history unavailable. {error instanceof Error ? error.message : ''}</Notice>); }
  }
  return shell(<>
    <section className={styles.card}>
      <h2>Physical receipts awaiting system GRN</h2>
      <p className={styles.trackerHelp}>These reports are operational follow-ups. They never add to system GRN actuals or plan achievement.
        Reconcile only against a specific matching real GRN detail; a PO reference alone is insufficient.</p>
      <form className={styles.trackerFilter}>
        <label>Plan period<select className="wf-input" name="cadence" defaultValue={cadence}>
          <option value="monthly">Monthly</option><option value="weekly">Weekly</option>
        </select></label><button type="submit" className="wf-btn wf-btn-ghost">View Plan</button>
      </form>
      <p className={styles.muted}>Weekly and monthly tracker reports are displayed separately. No combined quantity is calculated. Only approved plans contribute to analytics.</p>
      <div className={styles.scroll}><table className={styles.table}>
        <caption className={styles.srOnly}>V2 tracker reports by plan line</caption>
        <thead><tr><th>Plan / PO / SKU / size</th><th>Planned</th><th>Physical report</th><th>Valid reconciled</th><th>Awaiting system GRN</th><th>Follow-up</th></tr></thead>
        <tbody>{rows.map(line => {
          const entry = reports.get(line.id); const parent = plans.get(line.plan_id)!;
          return <tr key={line.id}>
            <td><Link href={'/inward-plan-v2/grn-delay-tracker?line=' + line.id}>{parent.title} · {parent.period_start}</Link>
              <br /><small>{STATUS_LABEL[parent.status]} · {line.po_number}{line.planning_level !== 'product' && <> / detail {line.po_detail_id}</>}</small><br />{line.planning_level === 'product' ? line.product_code : line.sku + ' / ' + (line.size || 'Unknown size')}</td>
            <td>{number(Number(line.inward_qty))}</td><td>{number(Number(entry?.reported_qty ?? 0))}</td>
            <td>{number(entry ? balances.effective.get(entry.id) ?? 0 : 0)}</td>
            <td>{number(entry ? balances.awaiting.get(entry.id) ?? 0 : 0)}</td><td>{entry?.follow_up_on ?? '—'}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {!rows.length && <p>No {cadence} plan lines yet.</p>}
    </section>
    {!!balances.warnings.length && <Notice tone="warn"><ul>{balances.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Notice>}
    {selected && plan && <>
      <section className={styles.card}>
        <h2>{selected.po_number} · {selected.planning_level === 'product' ? selected.product_code : selected.sku + ' / ' + (selected.size || 'Unknown size')}</h2>
        <p className={styles.trackerHelp}>{selected.planning_level === 'product' ? 'Product ' + selected.product_code : 'PO detail ' + selected.po_detail_id} · <Link href={'/inward-plan-v2?id=' + plan.id}>{plan.title}</Link></p>
        <p className={styles.trackerHelp}>Reported: {number(Number(report?.reported_qty ?? 0))} · Valid reconciled: {number(report ? balances.effective.get(report.id) ?? 0 : 0)}
          {' · '}Awaiting system GRN: <strong>{number(report ? balances.awaiting.get(report.id) ?? 0 : 0)}</strong></p>
        {editable ? <ReportForm key={'report-' + (report?.updated_at ?? 'new')} line={selected} report={report} today={today} /> :
          <p>Only this plan&apos;s owner or an admin may update the report.</p>}
        {report?.received_on && <p>Physical receipt: {report.received_on} · {report.delay_reason || 'No delay reason recorded.'}</p>}
      </section>
      {report && <section className={styles.card}>
        <h2>Reconcile against a real system GRN</h2>
        {editable && (balances.awaiting.get(report.id) ?? 0) > 0 && report.received_on ?
          <ReconcileForm key={'reconcile-' + report.updated_at} report={report}
            receipts={matchingGrns(selected, report.received_on, data.receipts)}
            sourceClaimed={[...balances.sourceClaimed]} awaiting={balances.awaiting.get(report.id) ?? 0} /> :
          <p>{!editable ? 'Only the plan owner or an admin may reconcile this report.' : (balances.awaiting.get(report.id) ?? 0) <= 0 ? 'No unreconciled reported quantity remains.' : 'Record a physical receipt date before reconciling.'}</p>}
        <h3>Reconciliation references and reversals</h3>
        {data.reconciliations.filter(row => row.tracker_id === report.id).map(row => <div className={styles.card} key={row.id}>
          <p><strong>GRN {row.grn_id ?? '—'} / detail {row.grn_detail_id}</strong> · {row.system_received_on} · {number(Number(row.quantity))} units</p>
          <p className={styles.muted}>{row.po_number} / detail {row.po_detail_id} · {row.sku} / {row.size || 'Unknown size'} · {when(row.created_at)} · {row.created_by}</p>
          {row.reversed_at ? <p>Reversed {when(row.reversed_at)} by {row.reversed_by}: {row.reversal_reason}</p> :
            editable && <ReverseForm key={row.id + report.updated_at} row={row} report={report} />}
        </div>)}
        {!data.reconciliations.some(row => row.tracker_id === report.id) && <p>No specific GRN has been reconciled yet.</p>}
      </section>}
      <section className={styles.card}>
        <h2>Tracker and reconciliation audit history</h2>
        {!history.length && <p>No tracker changes recorded.</p>}
        <ol className={styles.history}>{history.map(row => <li key={row.id}>
          <strong>{row.entity === 'grn_reconciliation' ? 'Reconciliation' : 'Physical report'} · {row.operation.toLowerCase()}</strong>
          <p className={styles.muted}>{when(row.changed_at)} · {row.changed_by}</p>
          <details><summary>View before / after</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify({ before: row.before_row, after: row.after_row }, null, 2)}</pre></details>
        </li>)}</ol>
      </section>
    </>}
  </>);
}
