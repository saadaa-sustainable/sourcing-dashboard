'use client';

import { useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { Download, Plus, Save, Trash2 } from 'lucide-react';
import {
  deleteInwardPlanEntry,
  reviewInwardPlanEntry,
  saveInwardPlanEntry,
  type ActionResult,
} from '@/lib/forms/actions';
import { addMonths, monthLabel } from '@/lib/forms/approval';
import { downloadCsv } from '@/lib/download';
import { Notice } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { INWARD_PLAN_STATUSES, type InwardPlanEntry, type SdRole } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const STATUS_TONE: Record<string, string> = {
  Pending: 'purple',
  Approved: 'teal',
  'RE-WORK': 'orange',
  Rejected: 'red',
};

export function InwardPlanIiClient({
  planMonth,
  entries,
  planCodes,
  role,
}: {
  planMonth: string;
  entries: InwardPlanEntry[];
  planCodes: string[];
  role: SdRole;
}) {
  const editable = role !== 'viewer';
  const isAdmin = role === 'admin';
  const [error, setError] = useState<string | null>(null);
  const [addCode, setAddCode] = useState('');
  const [pending, start] = useTransition();

  const totals = useMemo(() => {
    let qty = 0, value = 0, actual = 0, variation = 0;
    for (const e of entries) {
      const q = Number(e.inward_qty) || 0;
      qty += q;
      value += q * (Number(e.cost_per_piece) || 0);
      actual += Number(e.actual_inward_qty) || 0;
      variation += (Number(e.actual_inward_qty) || 0) - q;
    }
    return { qty, value, actual, variation };
  }, [entries]);

  function run(action: (fd: FormData) => Promise<ActionResult>, fields: Record<string, string>) {
    setError(null);
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) reloadWithToast();
      else setError(res.error);
    });
  }

  const exportCsv = () =>
    downloadCsv(
      `inward-plan-ii-${planMonth.slice(0, 7)}`,
      ['Product code', 'PO no.', 'Vendor', 'Inward qty', 'Cost/piece', 'Total value', 'Remarks', 'MT comments', 'Approval status', 'Actual inward qty', 'Variation'],
      entries.map((e) => {
        const q = Number(e.inward_qty) || 0;
        return [
          e.product_code, e.po_no ?? '', e.vendor_name ?? '', q,
          Number(e.cost_per_piece) || 0, q * (Number(e.cost_per_piece) || 0),
          e.remarks ?? '', e.mt_comments ?? '', e.approval_status,
          e.actual_inward_qty ?? '', (Number(e.actual_inward_qty) || 0) - q,
        ];
      }),
    );

  return (
    <>
      <Notice tone="info">
        The monthly inward sheet: <strong>product code comes from the buying plan</strong>; the team
        fills PO, vendor, quantity, cost and remarks; management adds <strong>MT comments</strong> and
        the <strong>approval status</strong>. Total Value and Variation (actual − planned) are computed.
      </Notice>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`/buying-plan?month=${addMonths(planMonth, -1)}&type=inward`}>
            ← {monthLabel(addMonths(planMonth, -1))}
          </a>
          <strong>{monthLabel(planMonth)}</strong>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`/buying-plan?month=${addMonths(planMonth, 1)}&type=inward`}>
            {monthLabel(addMonths(planMonth, 1))} →
          </a>
        </div>
        <div className="wf-toolbar-left">
          {editable && (
            <>
              <input
                className="wf-search"
                list="inward-plan-codes"
                placeholder="Product / material code…"
                value={addCode}
                onChange={(e) => setAddCode(e.target.value)}
              />
              <datalist id="inward-plan-codes">
                {planCodes.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
              <button
                type="button"
                className="wf-btn wf-btn-primary wf-btn-sm"
                disabled={pending || !addCode.trim()}
                onClick={() => {
                  run(saveInwardPlanEntry, { plan_month: planMonth, product_code: addCode });
                  setAddCode('');
                }}
              >
                <Plus size={14} /> Add row
              </button>
            </>
          )}
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={exportCsv} disabled={!entries.length}>
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>
                  Product code
                  <InfoDot text="From the buying plan — pick a code the month's plan carries (free entry allowed for unplanned/RM codes)." label="About Product code" />
                </th>
                <th>PO no.</th>
                <th>Vendor</th>
                <th className="num">Inward qty</th>
                <th className="num">Cost/piece</th>
                <th className="num">
                  Total value
                  <InfoDot text="Inward qty × cost per piece — computed, not entered." label="About Total value" />
                </th>
                <th>Remarks</th>
                <th>
                  MT comments
                  <InfoDot text="Management review note — editable by admins only." label="About MT comments" />
                </th>
                <th>Approval status</th>
                <th className="num">
                  Actual inward qty
                  <InfoDot text="What actually arrived, filled as the month closes." label="About Actual inward qty" />
                </th>
                <th className="num">
                  Variation
                  <InfoDot text="Actual − planned inward quantity." label="About Variation" />
                </th>
                {editable && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRow key={e.id} entry={e} planMonth={planMonth} editable={editable} isAdmin={isAdmin} run={run} busy={pending} />
              ))}
              {!entries.length && (
                <tr>
                  <td colSpan={editable ? 12 : 11} className="wf-empty-cell">
                    No rows yet for {monthLabel(planMonth)} — add the first product above.
                  </td>
                </tr>
              )}
            </tbody>
            {entries.length > 0 && (
              <tfoot>
                <tr>
                  <td><strong>TOTAL</strong></td>
                  <td colSpan={2} />
                  <td className="num"><strong>{fmt.format(totals.qty)}</strong></td>
                  <td />
                  <td className="num"><strong>{money.format(totals.value)}</strong></td>
                  <td colSpan={3} />
                  <td className="num"><strong>{fmt.format(totals.actual)}</strong></td>
                  <td className="num"><strong>{fmt.format(totals.variation)}</strong></td>
                  {editable && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  );
}

function EntryRow({
  entry,
  planMonth,
  editable,
  isAdmin,
  run,
  busy,
}: {
  entry: InwardPlanEntry;
  planMonth: string;
  editable: boolean;
  isAdmin: boolean;
  run: (action: (fd: FormData) => Promise<ActionResult>, fields: Record<string, string>) => void;
  busy: boolean;
}) {
  const [po, setPo] = useState(entry.po_no ?? '');
  const [vendor, setVendor] = useState(entry.vendor_name ?? '');
  const [qty, setQty] = useState(entry.inward_qty?.toString() ?? '');
  const [cost, setCost] = useState(entry.cost_per_piece?.toString() ?? '');
  const [remarks, setRemarks] = useState(entry.remarks ?? '');
  const [actual, setActual] = useState(entry.actual_inward_qty?.toString() ?? '');
  const [mt, setMt] = useState(entry.mt_comments ?? '');
  const [status, setStatus] = useState(entry.approval_status);

  const teamDirty =
    po !== (entry.po_no ?? '') ||
    vendor !== (entry.vendor_name ?? '') ||
    qty !== (entry.inward_qty?.toString() ?? '') ||
    cost !== (entry.cost_per_piece?.toString() ?? '') ||
    remarks !== (entry.remarks ?? '') ||
    actual !== (entry.actual_inward_qty?.toString() ?? '');
  const reviewDirty = mt !== (entry.mt_comments ?? '') || status !== entry.approval_status;

  const q = Number(qty) || 0;
  const totalValue = q * (Number(cost) || 0);
  const variation = (actual === '' ? 0 : Number(actual) || 0) - q;

  const save = () => {
    if (teamDirty) {
      run(saveInwardPlanEntry, {
        id: String(entry.id),
        plan_month: planMonth,
        product_code: entry.product_code,
        po_no: po,
        vendor_name: vendor,
        inward_qty: qty,
        cost_per_piece: cost,
        remarks,
        actual_inward_qty: actual,
      });
    }
    if (reviewDirty) {
      run(reviewInwardPlanEntry, { id: String(entry.id), mt_comments: mt, approval_status: status });
    }
  };

  const cell = (value: string, set: (v: string) => void, kind: 'text' | 'num' = 'text', width?: number) =>
    editable ? (
      <input
        type={kind === 'num' ? 'number' : 'text'}
        min={kind === 'num' ? 0 : undefined}
        value={value}
        style={width ? { width } : undefined}
        onChange={(e) => set(e.target.value)}
      />
    ) : (
      <span>{value || '—'}</span>
    );

  return (
    <tr>
      <td className="mono">{entry.product_code}</td>
      <td>{cell(po, setPo, 'text', 210)}</td>
      <td>{cell(vendor, setVendor, 'text', 90)}</td>
      <td className="num">{cell(qty, setQty, 'num', 80)}</td>
      <td className="num">{cell(cost, setCost, 'num', 80)}</td>
      <td className="num">{totalValue ? money.format(totalValue) : '—'}</td>
      <td>{cell(remarks, setRemarks, 'text', 150)}</td>
      <td>
        {isAdmin ? (
          <input value={mt} style={{ width: 200 }} onChange={(e) => setMt(e.target.value)} />
        ) : (
          <span>{entry.mt_comments || '—'}</span>
        )}
      </td>
      <td>
        {isAdmin ? (
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {INWARD_PLAN_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        ) : (
          <span className={`wf-status tone-${STATUS_TONE[entry.approval_status] ?? 'purple'}`}>
            {entry.approval_status}
          </span>
        )}
      </td>
      <td className="num">{cell(actual, setActual, 'num', 80)}</td>
      <td className="num" style={{ color: variation < 0 ? 'var(--danger-text, #c0392b)' : 'var(--success-text, #3d9e6b)' }}>
        {actual === '' && !q ? '—' : fmt.format(variation)}
      </td>
      {editable && (
        <td>
          <div className="wf-issue-row">
            {(teamDirty || reviewDirty) && (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={save} title="Save row">
                <Save size={13} />
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              disabled={busy}
              title="Remove row"
              onClick={() => run(deleteInwardPlanEntry, { id: String(entry.id) })}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}
