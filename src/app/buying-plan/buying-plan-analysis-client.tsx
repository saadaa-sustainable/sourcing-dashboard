'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { addMonths, monthLabel } from '@/lib/forms/approval';
import { Field } from '@/components/forms/form-layout';
import { FilterTable, type Column } from '@/components/filter-table';
import type {
  BuyingPlanAnalysis,
  BuyingPlanAnalysisProduct,
  BuyingPlanAnalysisStatus,
} from '@/lib/forms/analysis-types';

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const pctText = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`);
const signed = (v: number) => (v > 0 ? `+${num.format(v)}` : num.format(v));

const STATUS_LABEL: Record<BuyingPlanAnalysisStatus, string> = {
  on_plan: 'On plan',
  over: 'Issued above approved',
  short: 'Issued below approved',
  unissued: 'Approved, not issued',
  not_planned: 'Not in plan',
  not_approved: 'In plan, never approved',
};

// Highlight colours: red = exception (a) not budgeted, amber = exception (b) over-issued.
const STATUS_STYLE: Record<BuyingPlanAnalysisStatus, { bg: string; fg: string }> = {
  on_plan: { bg: '#ecf1e9', fg: '#4f7c4d' },
  over: { bg: '#fdf1dc', fg: '#9a6b12' },
  short: { bg: '#f3f1ec', fg: '#6e695e' },
  unissued: { bg: '#f3f1ec', fg: '#6e695e' },
  not_planned: { bg: '#fdecea', fg: '#c0392b' },
  not_approved: { bg: '#fdecea', fg: '#c0392b' },
};

function StatusBadge({ status }: { status: BuyingPlanAnalysisStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 600, background: s.bg, color: s.fg, whiteSpace: 'nowrap' }}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Tile({ q, val, note, tone }: { q: string; val: string; note: string; tone?: 'red' | 'amber' | 'green' }) {
  const color = tone === 'red' ? '#c0392b' : tone === 'amber' ? '#9a6b12' : tone === 'green' ? '#4f7c4d' : undefined;
  return (
    <div className="wf-macro-card">
      <span className="wf-macro-q">{q}</span>
      <strong className="wf-macro-val" style={color ? { color } : undefined}>{val}</strong>
      <span className="wf-subtle">{note}</span>
    </div>
  );
}

/** PO refs for a product, compact: "FY26-27/FOB/SDAVSK/KVN-10 (KVN · 1,200)". */
function PoList({ row }: { row: BuyingPlanAnalysisProduct }) {
  if (!row.pos.length) return <span className="wf-subtle">—</span>;
  return (
    <span style={{ fontSize: 12 }}>
      {row.pos.map((p, i) => (
        <span key={p.po_id}>
          {i > 0 && ', '}
          <span className="mono">{p.po_ref_num || p.po_number || p.po_id}</span>
          <span className="wf-subtle"> ({p.vendor_code ?? '?'} · {num.format(p.qty)})</span>
        </span>
      ))}
    </span>
  );
}

export function BuyingPlanAnalysisClient({ analysis }: { analysis: BuyingPlanAnalysis }) {
  const { planMonth, metrics: m, products, exceptions, hasPlan, planStatus, approvedLines, totalLines } = analysis;
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  const rows = useMemo(
    () => (onlyFlagged ? products.filter((r) => r.status !== 'on_plan' && r.status !== 'unissued' && r.status !== 'short') : products),
    [products, onlyFlagged],
  );

  const columns = useMemo<Column<BuyingPlanAnalysisProduct>[]>(
    () => [
      { key: 'product_code', label: 'Product', kind: 'mono', source: 'supabase' },
      {
        key: 'status', label: 'Status', filter: 'select', source: 'computed',
        accessor: (r) => STATUS_LABEL[r.status],
        render: (r) => <StatusBadge status={r.status} />,
        info: 'Red = issued but not budgeted (exception a). Amber = issued above the approved quantity (exception b).',
      },
      { key: 'plannedQty', label: 'Approved qty', kind: 'num', source: 'supabase', info: 'Sum of approved plan lines (Job + FOB + E-FOB) for the month.' },
      { key: 'issuedQty', label: 'Issued qty', kind: 'num', source: 'easyecom', info: 'Real EasyEcom POs (issued/completed) dated in the month.' },
      { key: 'deltaQty', label: 'Δ qty', kind: 'num', source: 'computed', render: (r) => <span style={{ color: r.deltaQty > 0 ? '#9a6b12' : r.deltaQty < 0 ? '#6e695e' : undefined }}>{signed(r.deltaQty)}</span> },
      { key: 'plannedValue', label: 'Approved value', kind: 'num', source: 'supabase', render: (r) => money.format(r.plannedValue) },
      { key: 'issuedValue', label: 'Issued value', kind: 'num', source: 'easyecom', render: (r) => money.format(r.issuedValue) },
      { key: 'deltaValue', label: 'Δ value', kind: 'num', source: 'computed', render: (r) => (r.deltaValue > 0 ? '+' : '') + money.format(r.deltaValue) },
      { key: 'poCount', label: 'POs', kind: 'num', source: 'easyecom' },
      { key: 'pos', label: 'PO references', filter: 'none', sortable: false, source: 'easyecom', accessor: (r) => r.pos.map((p) => p.po_ref_num || p.po_number || '').join(' '), render: (r) => <PoList row={r} /> },
    ],
    [],
  );

  const planNote = !hasPlan
    ? 'No finished-goods plan exists for this month — everything issued counts as not budgeted.'
    : planStatus === 'approved' || approvedLines > 0
      ? `Plan ${planStatus} · ${approvedLines} of ${totalLines} lines approved.`
      : `Plan is ${planStatus} — no lines approved yet, so every issued PO shows as not budgeted until approval.`;

  return (
    <div className="wf-stack">
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Month">
            <select
              value={planMonth}
              onChange={(e) => { window.location.href = `/buying-plan?month=${e.target.value}&type=analysis`; }}
            >
              {[-3, -2, -1, 0, 1].map((delta) => {
                const month = addMonths(planMonth, delta);
                return <option key={month} value={month}>{monthLabel(month)}</option>;
              })}
            </select>
          </Field>
          <span className="wf-subtle" style={{ fontSize: 12 }}>{planNote}</span>
        </div>
      </div>

      {/* Five variance metrics for the month */}
      <div className="wf-macro">
        <Tile
          q="Quantity variation"
          val={`${num.format(m.issuedQty)} / ${num.format(m.plannedQty)} pcs`}
          note={`issued vs approved · ${signed(m.issuedQty - m.plannedQty)} (${pctText(m.qtyVarPct)})`}
          tone={m.issuedQty > m.plannedQty ? 'amber' : undefined}
        />
        <Tile
          q="Value variation"
          val={`${money.format(m.issuedValue)} / ${money.format(m.plannedValue)}`}
          note={`issued vs approved · ${pctText(m.valueVarPct)}`}
          tone={m.issuedValue > m.plannedValue ? 'amber' : undefined}
        />
        <Tile
          q="PO count variation"
          val={`${num.format(m.actualPoCount)} / ${num.format(m.plannedPoCount)}`}
          note={`actual POs vs planned (product × PO-type cells) · ${signed(m.actualPoCount - m.plannedPoCount)}`}
        />
        <Tile
          q="Excess %"
          val={pctText(m.excessPct) === '—' ? '—' : `${(m.excessPct! * 100).toFixed(1)}%`}
          note={`${num.format(m.excessQty)} pcs · ${money.format(m.excessValue)} issued above approved`}
          tone={m.excessQty > 0 ? 'amber' : 'green'}
        />
        <Tile
          q="Short"
          val={`${num.format(m.shortQty)} pcs`}
          note={`${pctText(m.shortPct) === '—' ? '—' : (m.shortPct! * 100).toFixed(1) + '%'} of approved · ${money.format(m.shortValue)} not yet issued`}
          tone={m.shortQty > 0 ? 'red' : 'green'}
        />
      </div>

      {/* Exception (a): issued but not budgeted */}
      <div className="wf-card" style={{ borderLeft: '4px solid #c0392b' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 6 }}>
          <AlertTriangle size={16} style={{ color: '#c0392b' }} />
          Issued but NOT budgeted — {exceptions.notBudgeted.length} product{exceptions.notBudgeted.length === 1 ? '' : 's'}
        </div>
        <p className="wf-subtle" style={{ margin: '0 0 8px', fontSize: 12 }}>
          POs issued for products that are not in the {monthLabel(planMonth)} buying plan, or are in the plan but were never approved. Why were these issued?
        </p>
        {exceptions.notBudgeted.length === 0 ? (
          <div className="wf-subtle">None — every issued product was budgeted and approved.</div>
        ) : (
          <div className="table-scroll">
            <table className="wf-grid">
              <thead><tr><th>Product</th><th>Reason</th><th className="num">Issued qty</th><th className="num">Issued value</th><th className="num">POs</th><th>PO references</th></tr></thead>
              <tbody>
                {exceptions.notBudgeted.map((r) => (
                  <tr key={r.product_code}>
                    <td className="mono"><strong>{r.product_code}</strong></td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="num">{num.format(r.issuedQty)}</td>
                    <td className="num">{money.format(r.issuedValue)}</td>
                    <td className="num">{r.poCount}</td>
                    <td><PoList row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Exception (b): issued above approved */}
      <div className="wf-card" style={{ borderLeft: '4px solid #e0a400' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 6 }}>
          <TrendingUp size={16} style={{ color: '#9a6b12' }} />
          Issued ABOVE approved quantity — {exceptions.overApproved.length} product{exceptions.overApproved.length === 1 ? '' : 's'}
        </div>
        <p className="wf-subtle" style={{ margin: '0 0 8px', fontSize: 12 }}>
          Approved 100, issued 110 — the excess over what the plan approved.
        </p>
        {exceptions.overApproved.length === 0 ? (
          <div className="wf-subtle">None — nothing was issued above its approved quantity.</div>
        ) : (
          <div className="table-scroll">
            <table className="wf-grid">
              <thead><tr><th>Product</th><th className="num">Approved</th><th className="num">Issued</th><th className="num">Excess</th><th className="num">Excess %</th><th className="num">Excess value</th><th>PO references</th></tr></thead>
              <tbody>
                {exceptions.overApproved.map((r) => (
                  <tr key={r.product_code}>
                    <td className="mono"><strong>{r.product_code}</strong></td>
                    <td className="num">{num.format(r.plannedQty)}</td>
                    <td className="num">{num.format(r.issuedQty)}</td>
                    <td className="num" style={{ color: '#9a6b12', fontWeight: 600 }}>+{num.format(r.deltaQty)}</td>
                    <td className="num">{r.plannedQty > 0 ? `${((r.deltaQty / r.plannedQty) * 100).toFixed(1)}%` : '—'}</td>
                    <td className="num">{r.deltaValue > 0 ? '+' + money.format(r.deltaValue) : '—'}</td>
                    <td><PoList row={r} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Every product: approved vs issued */}
      <div className="wf-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <strong>All products — approved vs issued</strong>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            flagged only
          </label>
          <span className="wf-subtle" style={{ fontSize: 12 }}>
            <TrendingDown size={12} style={{ verticalAlign: '-2px' }} /> {m.approvedProducts} approved · {m.issuedProducts} issued
          </span>
        </div>
        <FilterTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.product_code}
          defaultSource="computed"
          unit="products"
          searchPlaceholder="Search product / PO…"
          emptyText="Nothing planned or issued for this month."
          download={{ filename: `buying-plan-analysis-${planMonth.slice(0, 7)}` }}
        />
      </div>
    </div>
  );
}
