'use client';

import { useState } from 'react';
import { visibleComplianceRows, complianceTotals, type ComplianceMonth, type ComplianceRow, type WeekCompliance } from '@/lib/vendor-capacity-compliance';

const pct = (n: number | null) => n == null ? 'Not available' : `${n}%`;
const label: Record<WeekCompliance, string> = { updated: 'Updated', due: 'Due', missed: 'Missed', unknown: 'Not available', 'not-required': 'Not required' };
const date = (at: string | null) => at ? new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Never updated';
export function ComplianceCells({ row }: { row?: ComplianceRow }) {
  return <>
    <td>{row ? <span className={`vc-vendor-status is-${row.vendorStatus}`}>{row.vendorStatus === 'active' ? 'Active' : 'Inactive'}</span> : 'Not available'}</td>
    <td>{row?.currentWeek === 'due' ? <span className="vc-compliance-due">Due</span> : row ? label[row.currentWeek] : 'Not available'}</td>
    <td className="num">{row ? <>{pct(row.score)}<small className="vc-compliance-detail">{row.updated}/{row.completed} completed weeks{row.unknown ? ` / ${row.unknown} unavailable` : ''}</small></> : 'Not available'}</td>
    <td className="num">{row?.missedWeeks == null ? 'Not available' : `${row.streakPartial && row.missedWeeks > 0 ? 'at least ' : ''}${row.missedWeeks}`}</td>
  </>;
}
export function ComplianceKpis({ rows, currentWeek }: { rows: ComplianceRow[]; currentWeek: string }) {
  const totals = complianceTotals(rows);
  return (
    <div className="vc-metrics vc-compliance-kpis">
      <div className="vc-metric vc-metric-blue"><span className="vc-metric-label">This week update coverage</span><strong>{pct(totals.currentPct)}</strong><small>{totals.currentUpdated}/{totals.currentEligible} eligible vendors / week of {currentWeek}</small></div>
      <div className="vc-metric vc-metric-green"><span className="vc-metric-label">Monthly compliance</span><strong>{pct(totals.score)}</strong><small>{totals.updated}/{totals.completed} completed vendor-weeks / {totals.unknown} unavailable</small></div>
      <div className="vc-metric vc-metric-amber"><span className="vc-metric-label">Overdue vendors</span><strong>{totals.overdue}</strong><small>Missed the latest completed week; current-week saves do not erase a missed week.</small></div>
    </div>
  );
}

export function CapacityComplianceView({ reports }: { reports: ComplianceMonth[] }) {
  const [selected, setSelected] = useState(reports[0]?.month ?? '');
  const [merchant, setMerchant] = useState('');
  const [search, setSearch] = useState('');
  const [overdue, setOverdue] = useState(false);
  const report = reports.find((r) => r.month === selected) ?? reports[0];
  if (!report) return <p role="status">Compliance history is not available.</p>;
  const merchants = [...new Set(report.rows.map((r) => r.merchant))].sort();
  const scoped = report.rows.filter((r) => (!merchant || r.merchant === merchant) && `${r.code} ${r.name}`.toLowerCase().includes(search.trim().toLowerCase()));
  const visibleCodes = new Set(visibleComplianceRows(report).map((r) => r.code));
  const rows = scoped.filter((r) => visibleCodes.has(r.code) && (!overdue || r.overdue)).sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.name.localeCompare(b.name));
  return <section className="vc-compliance" aria-label="Capacity update compliance">
    <div className="vc-compliance-heading"><div><h2>Update compliance</h2><p>One confirmed update per eligible vendor each week / Monday-Sunday, IST / Goal: 100%</p></div>
      <label>Reporting month<select value={report.month} onChange={(e) => setSelected(e.target.value)}>{reports.map((r) => <option key={r.month} value={r.month}>{new Date(`${r.month}T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}</option>)}</select></label>
    </div>
    <ComplianceKpis rows={scoped} currentWeek={report.currentWeek} />
    <div className="vc-compliance-filters">
      <label>Vendor<input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code" /></label>
      <label>Merchant<select value={merchant} onChange={(e) => setMerchant(e.target.value)}><option value="">All merchants</option>{merchants.map((m) => <option key={m}>{m}</option>)}</select></label>
      <label className="vc-compliance-toggle"><input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />Overdue only (latest completed week)</label>
      <button type="button" className="vc2-btn" onClick={() => { setMerchant(''); setSearch(''); setOverdue(false); }}>Clear filters</button>
    </div>
    <p className="vc-compliance-note">{rows.length} vendors shown. KPI cards follow vendor and merchant filters; Overdue only narrows the follow-up table. Current-week KPIs always refer to the live week. Inactive vendors appear only if their last update is in the current week; historical eligible weeks remain included in monthly KPIs.</p>
    <div className="table-scroll"><table className="wf-grid vc-compliance-table"><thead><tr><th>Vendor</th><th>Merchant (current)</th><th>Last updated (IST)</th><th>Vendor status</th><th>This week</th><th className="num">Monthly compliance</th><th className="num">Consecutive missed weeks</th><th>Weekly record</th></tr></thead>
      <tbody>{rows.map((r) => <tr key={r.code}><td><strong>{r.name}</strong><small className="vc-compliance-detail">{r.code}{r.overdue ? ' / Follow up' : ''}</small></td><td>{r.merchant}</td><td>{date(r.lastUpdated)}</td><ComplianceCells row={r} /><td><div className="vc-compliance-weeks">{r.weeks.map((w) => <span key={w.week} className={`vc-compliance-week is-${w.status}`} title={`Week starting ${w.week}: ${label[w.status]}`}>{w.week.slice(5)} / {label[w.status]}</span>)}</div></td></tr>)}
        {!rows.length && <tr><td colSpan={8}>No vendors match these filters.</td></tr>}
      </tbody></table></div>
    <details className="vc-compliance-method"><summary>How the score is calculated</summary><ul>
      <li>Monthly compliance = updated completed vendor-weeks / eligible completed vendor-weeks x 100. Weeks belong to the month containing their Monday. The unfinished week is excluded.</li>
      <li>Each vendor counts at most once per week. Explicit confirmation of unchanged figures and valid zero-karigar saves count; repeated saves do not improve the score.</li>
      <li>Only full eligible weeks count. Onboarding after Monday, inactive periods and approved deboarding are excluded. Active/Inactive follows the source is_active flag. Historical eligibility uses its audited values; missing historical flags remain unavailable.</li>
      <li>Complete observed history starts {report.coverageStart ?? 'when both audit trails become available'}. Earlier weeks and unknown eligibility are unavailable and excluded, never scored as zero. A score with unavailable weeks covers only known weeks.</li>
      <li>Consecutive misses end at an updated, ineligible or unknown week. "At least" means the known streak reaches the history boundary. Merchant attribution uses the current assignment.</li>
      <li>This measures reporting discipline. Overutilization and karigar deficit do not reduce this score; an exception reason does not excuse a missed update.</li>
    </ul></details>
  </section>;
}
