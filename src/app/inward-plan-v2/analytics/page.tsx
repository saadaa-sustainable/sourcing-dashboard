import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Notice } from '@/components/forms/form-layout';
import { context, V2SignInRequired } from '@/lib/inward-plan-v2/server';
import { loadGrnData } from '@/lib/inward-plan-v2/grn-server';
import { calculateAnalytics } from '@/lib/inward-plan-v2/analytics';
import { periodBounds } from '@/lib/inward-plan-v2/validation';
import { ReportingShell } from '../reporting-shell';
import styles from '../v2.module.css';
import reportStyles from './report.module.css';

export const dynamic = 'force-dynamic';
const number = (value: number) => value.toLocaleString('en-IN', { maximumFractionDigits: 3 });
const percent = (value: number | null) => value == null ? '—' : value.toFixed(1) + '%';
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ cadence?: string; start?: string }> }) {
  const params = await searchParams;
  let access;
  try { access = await context(); } catch (error) {
    if (error instanceof V2SignInRequired) redirect('/login');
    return <ReportingShell section="analytics" title="Inward Plan V2 Analytics" role="viewer"><Notice tone="error">{error instanceof Error ? error.message : 'Access denied.'}</Notice></ReportingShell>;
  }
  const shell = (content: React.ReactNode) => <ReportingShell section="analytics" title="Inward Plan V2 Analytics"
    role={access.role} email={access.email} allowedPages={access.allowedPages}>{content}</ReportingShell>;
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
  const cadence = params.cadence ?? 'monthly';
  if (cadence !== 'monthly' && cadence !== 'weekly') return shell(<Notice tone="error">Choose weekly or monthly analytics.</Notice>);
  const monday = new Date(today + 'T00:00:00Z'); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const start = params.start ?? (cadence === 'weekly' ? monday.toISOString().slice(0, 10) : today.slice(0, 8) + '01');
  const filters = <>
    <nav className={`${styles.buttons} ${reportStyles.cadenceTabs}`} aria-label="Analytics baseline">
      <Link href="/inward-plan-v2/analytics?cadence=monthly" aria-current={cadence === 'monthly' ? 'page' : undefined}>Monthly</Link>
      <Link href="/inward-plan-v2/analytics?cadence=weekly" aria-current={cadence === 'weekly' ? 'page' : undefined}>Weekly</Link>
    </nav>
    <form className={reportStyles.periodFilter}>
      <input type="hidden" name="cadence" value={cadence} />
      <label>{cadence === 'weekly' ? 'Week starting Monday' : 'Month starting on the 1st'}
        <input name="start" type="date" className="wf-input" required defaultValue={start} /></label>
      <button className="wf-btn wf-btn-primary" type="submit">View period</button>
    </form>
  </>;
  try { periodBounds(cadence, start); } catch (error) {
    return shell(<section className={styles.card}>{filters}<Notice tone="error">{error instanceof Error ? error.message : 'Choose a valid planning period.'}</Notice></section>);
  }
  let data;
  let result;
  try {
    data = await loadGrnData();
    result = calculateAnalytics(data, cadence, start, today);
  } catch (error) {
    return shell(<section className={styles.card}>{filters}<Notice tone="error">Analytics unavailable. {error instanceof Error ? error.message : ''} No totals have been substituted.
      <p>Ensure all V2 migrations have been applied.</p></Notice></section>);
  }
  const sync = data.receipts.reduce((latest, receipt) => receipt.synced_at > latest ? receipt.synced_at : latest, '');
  const maxDaily = Math.max(1, ...result.daily.flatMap(day => [day.planned, day.actual]));
  return shell(<section className={`${styles.card} ${reportStyles.analyticsSection}`} aria-label={cadence === 'monthly' ? 'Monthly analytics' : 'Weekly analytics'}>
    <div className={reportStyles.overview}>
      {filters}
      <p><strong>{result.start} – {result.end}</strong> · System receipts through {today} IST</p>
      <p className={styles.muted}>Weekly and monthly plans are alternative baselines and are never added together.
        Only approved plans contribute planned quantities. Repeated schedules share each system GRN once.</p>
      {sync && <p className={styles.muted}>Latest source sync among loaded references: {new Date(sync).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.</p>}
    </div>
    {!!result.warnings.length && <Notice tone="warn"><ul>{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Notice>}
    <section className={reportStyles.metrics} aria-label="Selected period metrics">
      {[['Planned', number(result.planned)], ['Actual system GRN', number(result.actual)],
        ['Achievement', percent(result.achievement)], ['Shortfall', number(result.shortfall)],
        ['Late GRN in period', number(result.late)], ['Awaiting system GRN', number(result.awaiting)]].map(([label, value]) =>
        <div className={reportStyles.metric} key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className={reportStyles.block}>
      <h2>Planned vs actual by receipt day</h2>
      <div className={reportStyles.legend}><span>Planned</span><span>System GRN</span></div>
      {result.daily.map(day => <div className={reportStyles.day} key={day.date}>
        <span>{day.date}</span><div className={reportStyles.bars} aria-label={day.date + ': planned ' + number(day.planned) + ', actual ' + number(day.actual)}>
          <div className={reportStyles.planned} style={{ width: day.planned / maxDaily * 100 + '%' }} />
          <div className={reportStyles.actual} style={{ width: day.actual / maxDaily * 100 + '%' }} />
        </div><span>{number(day.planned)} / {number(day.actual)}</span>
      </div>)}
      {!result.rows.length && <p>No approved {cadence} plan lines for this period.</p>}
    </section>
    <section className={reportStyles.block}>
      <h2>PO / product reconciliation</h2>
      <div className={styles.scroll}><table className={styles.table}>
        <caption className={styles.srOnly}>Weekly or monthly performance by planned PO and product</caption>
        <thead><tr><th>PO / product</th><th>Planned</th><th>System GRN</th><th>Achievement</th><th>Shortfall</th><th>Late in period</th><th>Late after period</th><th>Awaiting system GRN</th><th>References</th></tr></thead>
        <tbody>{result.rows.map(row => <tr key={row.key}>
          <td>{row.po_number}<br /><strong>{row.product_code}</strong>{row.planning_level !== 'product' && <><br /><small>{row.sku} / {row.size || 'Unknown size'}</small></>}</td>
          <td>{number(row.planned)}</td><td>{number(row.actual)}</td><td>{percent(row.achievement)}</td><td>{number(row.shortfall)}</td>
          <td>{number(row.late)}</td><td>{number(row.lateAfterPeriod)}</td><td>{number(row.awaiting)}</td>
          <td><details><summary>{row.references.length} GRN details</summary><ul>{row.references.map(receipt =>
            <li key={receipt.grn_detail_id}>GRN {receipt.grn_id ?? '—'} / detail {receipt.grn_detail_id} · {receipt.received_on} · {number(Number(receipt.received_qty))}</li>)}</ul></details></td>
        </tr>)}</tbody>
      </table></div>
      <details className={reportStyles.definitions}><summary>Metric definitions and allocation rules</summary>
        <p>Actual = unique system received quantities dated within this period for each planned PO/product; legacy SKU plans retain exact source matching unless combined with a product baseline. It is not QC-passed quantity.
          Tracker reports never increase actual, achievement or late receipts. Achievement = actual / planned; it can exceed 100%. Shortfall sums positive deficits per grain.</p>
        <p>Late receipts use chronological GRNs allocated to the earliest outstanding approved schedule of this cadence, within the same exact grain.
          A receipt cannot fulfill a schedule before its planning period starts. Over-receipts without a remaining scheduled quantity are excluded from late quantities.
          “Late after period” is supplementary fulfillment after the period, through today; it is excluded from this period&apos;s actual and achievement.</p>
        <p>Awaiting system GRN = physically reported tracker quantity minus valid, specifically referenced reconciliations.
          Source deletions, quantity reductions or identity changes raise review warnings and restore the affected awaiting quantity.
          Blank source sizes remain unknown; no size is guessed and no loose PO matching is used.</p>
      </details>
      <div className={reportStyles.footerActions}><Link className="wf-btn wf-btn-ghost" href="/inward-plan-v2/grn-delay-tracker">Open GRN Delay Tracker</Link></div>
    </section>
  </section>);
}
