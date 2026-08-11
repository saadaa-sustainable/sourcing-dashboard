/**
 * Woven-vs-Knitted pivot summary for the Buying Plan, shared by the plan's View
 * mode and the Approvals screen. Shows two prominent big-number totals (Total
 * Qty, Total Value) so the scale is obvious before drilling in, then a pivot
 * table breaking each fabric type into Pending vs Approved, for both Qty and
 * Value. A line counts as "approved" once its line_status is 'approved'.
 */

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

export type PivotRow = {
  fabricType: string | null;
  qty: number;
  value: number;
  approved: boolean;
};

type Cell = { pendingQty: number; pendingValue: number; approvedQty: number; approvedValue: number };

const emptyCell = (): Cell => ({ pendingQty: 0, pendingValue: 0, approvedQty: 0, approvedValue: 0 });

export function PlanPivot({ rows, title }: { rows: PivotRow[]; title?: string }) {
  const byFabric = new Map<string, Cell>();
  const total = emptyCell();
  for (const r of rows) {
    const key = r.fabricType && r.fabricType.trim() ? r.fabricType : 'Unspecified';
    const cell = byFabric.get(key) ?? emptyCell();
    if (r.approved) {
      cell.approvedQty += r.qty;
      cell.approvedValue += r.value;
      total.approvedQty += r.qty;
      total.approvedValue += r.value;
    } else {
      cell.pendingQty += r.qty;
      cell.pendingValue += r.value;
      total.pendingQty += r.qty;
      total.pendingValue += r.value;
    }
    byFabric.set(key, cell);
  }
  const fabrics = [...byFabric.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const totalQty = total.pendingQty + total.approvedQty;
  const totalValue = total.pendingValue + total.approvedValue;

  if (!rows.length) return null;

  return (
    <div className="wf-pivot-wrap">
      {title && <h3 className="wf-pivot-title">{title}</h3>}
      <div className="wf-bignum-grid">
        <div className="wf-bignum">
          <span className="metric-label">Total quantity</span>
          <strong>{fmt.format(totalQty)}</strong>
          <small>pcs across all lines</small>
        </div>
        <div className="wf-bignum">
          <span className="metric-label">Total value</span>
          <strong>{money.format(totalValue)}</strong>
          <small>at approved standard cost</small>
        </div>
      </div>

      <div className="table-panel">
        <div className="table-scroll">
          <table className="wide-table wf-pivot">
            <thead>
              <tr>
                <th rowSpan={2}>Fabric</th>
                <th colSpan={2} className="num wf-pivot-pending">Pending approval</th>
                <th colSpan={2} className="num wf-pivot-approved">Approved</th>
              </tr>
              <tr>
                <th className="num wf-pivot-pending">Qty</th>
                <th className="num wf-pivot-pending">Value</th>
                <th className="num wf-pivot-approved">Qty</th>
                <th className="num wf-pivot-approved">Value</th>
              </tr>
            </thead>
            <tbody>
              {fabrics.map(([fabric, c]) => (
                <tr key={fabric}>
                  <td className="strong">{fabric}</td>
                  <td className="num">{fmt.format(c.pendingQty)}</td>
                  <td className="num">{money.format(c.pendingValue)}</td>
                  <td className="num">{fmt.format(c.approvedQty)}</td>
                  <td className="num">{money.format(c.approvedValue)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td className="num strong">{fmt.format(total.pendingQty)}</td>
                <td className="num strong">{money.format(total.pendingValue)}</td>
                <td className="num strong">{fmt.format(total.approvedQty)}</td>
                <td className="num strong">{money.format(total.approvedValue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
