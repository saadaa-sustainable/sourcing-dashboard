import type { VendorPoHistory } from '@/lib/forms/queries-modules/vendor';

const num = (n: number | null) => n == null ? 'Not available' : new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 }).format(n);
const pct = (n: number | null) => n == null ? 'Not available' : `${num(n)}%`;
export function VendorCapacityAnalytics({ data }: { data: VendorPoHistory }) {
  const { capacity: c, all, same } = data.analytics;
  const metrics = [
    ['Monthly capacity', c.entered ? `${num(c.capacityPerMonth)} pcs` : 'Not reported'],
    ['Current utilisation', pct(c.capacityUtil)],
    ['Last reported headcount', c.headcount == null ? 'Not reported' : `${num(c.headcount)} karigars`],
    ['Report date', c.reportDate ? new Date(c.reportDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' }) : 'Not reported'],
    ['Active in-process quantity', `${num(c.inProcessQty)} pcs`],
    [`Capacity in ${c.leadDays}-day PO period`, c.entered ? `${num(c.poCapacity)} pcs` : 'Not available'],
    ['Available capacity', c.available == null ? 'Not available' : `${num(c.available)} pcs`],
    ['Capacity days remaining', c.daysRemaining == null ? 'Not available' : `${num(c.daysRemaining)} days`],
    ['This PO quantity', c.poQty == null ? 'Not supplied' : `${num(c.poQty)} pcs`],
  ];
  return <section className="pc-section vh-analytics" aria-label="Vendor Capacity Analytics">
    <h4>Vendor Capacity Analytics</h4>
    <dl className="vh-capacity-grid">{metrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    <div className="table-scroll"><table className="pc-table vh-performance">
      <caption>Delivery performance - all available received PO history</caption>
      <thead><tr><th>Scope</th><th>POs with Receipts</th><th>POs with Due Dates</th><th>OTIF</th><th>On-time rate</th><th>Fill rate</th><th>Average delay</th></tr></thead>
      <tbody>{[{ label: "All POs", p: all }, { label: data.productCode ? `Same product - ${data.productCode}` : "Same product (select a product)", p: same }].map(({ label, p }) => {
        return <tr key={String(label)}><th scope="row">{String(label)}</th><td>{p.pos}</td><td>{p.datedPos}</td><td><strong>{pct(p.otif)}</strong></td><td><strong>{pct(p.onTime)}</strong></td><td>{pct(p.fill)}</td><td>{p.delay == null ? 'Not available' : `${num(p.delay)} days`}</td></tr>;
      })}</tbody>
    </table></div>
    <p className="wf-subtle vh-performance-note">
      {all.datedPos > 0
        ? `OTIF and on-time rate are based on ${all.datedPos} received POs with delivery due dates. A rate of 0% means none met the measure; it is not missing data.`
        : 'No received POs have a usable delivery due date, so OTIF and on-time rate cannot be calculated.'}
      {all.pos > all.datedPos ? ` ${all.pos - all.datedPos} received POs without a due date are excluded from these two rates.` : ''}
    </p>
    <div className="vh-recommendation" role="status"><strong>{c.recommendation}</strong><ul>{c.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p>Decision support only. Confirm the reported headcount and production schedule with the vendor before issuing.</p></div>
    <details className="vh-definitions"><summary>How these figures are calculated</summary><p>Capacity and utilisation use the existing Vendor Capacity model and the selected PO type's lead time. Capacity days remaining = available pieces / (monthly capacity / 30); a negative value means overload.</p><p>OTIF = dated received POs that arrived on time and in full / dated received POs. On-time rate uses the same dated denominator. Fill rate is the percentage of received POs supplied in full, not the percentage of pieces received. Average delay includes zero days for early/on-time POs and excludes POs without a due date. Latest vendor commitment takes precedence over PO expected date. Receipt timing uses the last GRN date; partially received POs can still change. Same-product figures cover whole POs containing that exact product.</p><p>Any dated PO below full OTIF triggers a delivery-risk review; no automatic approval or issuance restriction is applied. Missing dates and missing capacity are not treated as a zero success rate.</p></details>
  </section>;
}
