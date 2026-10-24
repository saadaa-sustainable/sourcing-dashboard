import { MonthBoard } from '@/components/month-board';
import { buildPlanBoard } from '@/lib/inward-plan-v2/plan-board';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { context, findSources, loadPlan, loadPlans, loadBoardLines, V2SignInRequired } from '@/lib/inward-plan-v2/server';
import { UUID } from '@/lib/inward-plan-v2/validation';
import { STATUS_LABEL } from '@/lib/inward-plan-v2/types';
import type { HistoryEntry } from '@/lib/inward-plan-v2/types';
import { Workspace } from './workspace';
import { InwardPlanNavigation } from './reporting-shell';
import styles from './v2.module.css';

export const dynamic = 'force-dynamic';
const when = (date: string) => new Date(date).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
const hiddenHistoryFields = new Set(['updated_at', 'updated_by', 'created_at', 'created_by']);
function History({ rows }: { rows: HistoryEntry[] }) {
  return <details className={`${styles.card} ${styles.historyDisclosure}`}><summary><h2>Approval and change history</h2></summary>
    {!rows.length && <p>No changes recorded.</p>}
    <ol className={styles.history}>{rows.map(row => {
      const before = row.before_row ?? {};
      const after = row.after_row ?? {};
      const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter(field => !hiddenHistoryFields.has(field) && JSON.stringify(before[field]) !== JSON.stringify(after[field]));
      return <li key={row.id}>
        <strong>{row.entity === 'plan' && row.to_status ? STATUS_LABEL[row.to_status] : row.entity + ' ' + row.operation.toLowerCase()}</strong>
        <p className={styles.muted}>{when(row.changed_at)} · {row.changed_by}</p>
        <details><summary>View changes</summary><dl>{fields.map(field => <div key={field}>
          <dt>{field.replaceAll('_', ' ')}</dt><dd>{String(before[field] ?? '—')} → {String(after[field] ?? '—')}</dd>
        </div>)}</dl></details>
      </li>;
    })}</ol>
  </details>;
}
export default async function InwardPlanV2Page({ searchParams }: {
  searchParams: Promise<{ id?: string; new?: string; filter?: string; saved?: string; approved?: string }>;
}) {
  const params = await searchParams;
  let access;
  try { access = await context(); }
  catch (error) {
    if (error instanceof V2SignInRequired) redirect('/login');
    return <FormLayout title="Inward Plan V2" active="/inward-plan-v2" role="viewer">
      <Notice tone="error">{error instanceof Error ? error.message : 'Access could not be verified.'}</Notice>
    </FormLayout>;
  }
  const { role, email, allowedPages } = access;
  const shell = (children: React.ReactNode) => <FormLayout title="Inward Plan V2"
    subtitle="Plan weekly and monthly receipts, review PO/SKU quantities and track approvals."
    active="/inward-plan-v2" role={role} userEmail={email} allowedPages={allowedPages} accent="teal">
    <InwardPlanNavigation section="plans" />
    {children}
  </FormLayout>;
  if (params.id && !UUID.test(params.id)) notFound();
  let plans;
  let boardLines: Awaited<ReturnType<typeof loadBoardLines>> = [];
  let detail;
  let sources;
  try {
    if (params.id) {
      detail = await loadPlan(params.id);
      if (detail.plan && detail.plan.status !== 'approved' && role !== 'viewer' &&
        (role === 'admin' || detail.plan.created_by === email)) sources = await findSources();
    } else if (params.new === '1') {
      if (role === 'viewer') return shell(<Notice tone="error">Only team and admin users can create a plan.</Notice>);
      sources = await findSources();
    } else {
      plans = await loadPlans();
      boardLines = await loadBoardLines(plans.map(plan => plan.id));
    }
  } catch (error) {
    return shell(<Notice tone="error">Unable to load Inward Plan V2. {error instanceof Error ? error.message : ''}
      <p>The V2 database migrations must be installed before using this workflow.</p></Notice>);
  }
  if (params.id && !detail?.plan) notFound();
  if (detail?.plan || params.new === '1') return shell(<>
    {params.approved === '1' && <Notice tone="ok">Edits saved and plan approved.</Notice>}
    {params.saved === '1' && <Notice tone="ok">Plan saved. Review the saved values before submitting.</Notice>}
    <Workspace key={detail?.plan?.updated_at ?? 'new'} plan={detail?.plan ?? null} lines={detail?.lines ?? []}
      sources={sources ?? []} role={role} email={email}
      today={new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)} />
    {detail && <History rows={detail.history} />}
  </>);
  const visible = (plans ?? []).filter(plan => params.filter === 'pending' ? plan.status === 'pending_l2'
    : params.filter === 'mine' ? plan.created_by === email : true);
  return shell(<div className={styles.planBoard}>
    <MonthBoard data={buildPlanBoard(visible, boardLines)} searchPlaceholder="Search plan or period..."
      pageBar={role !== 'viewer' ? <Link className="wf-btn wf-btn-primary" href="/inward-plan-v2?new=1">Create a Plan</Link> : undefined} />
  </div>);
}
