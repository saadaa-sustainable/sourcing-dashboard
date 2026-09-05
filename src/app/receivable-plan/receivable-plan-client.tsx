'use client';

import { useMemo, useState, useTransition } from 'react';
import { Save } from 'lucide-react';
import { useColumnSort } from '@/lib/use-column-sort';
import { saveReceivableInput, submitReceivablePlan } from '@/lib/forms/actions';
import { Notice } from '@/components/forms/form-layout';
import type { ReceivablePlanRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const SIZE_KEYS = [
  ['size_xs', 'XS'], ['size_s', 'S'], ['size_m', 'M'], ['size_l', 'L'],
  ['size_xl', 'XL'], ['size_2xl', '2XL'], ['size_3xl', '3XL'],
  ['size_4xl', '4XL'], ['size_5xl', '5XL'],
] as const;
const cell = (v: number | null) => (v ? fmt.format(v) : '');
// Dropdown option meaning “value is blank”.
const BLANK = '—';
const statusTone = (s: string | null) =>
  s === 'Overdue' ? 'danger' : s === 'High Risk' ? 'warn' : 'success';

/* ---- Week helpers: the team plans by receiving WEEK (Mon–Sun), not a single
   date. We store the Monday of the chosen week in delivery_date_this_week. ---- */
function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0 Sun … 6 Sat
  d.setUTCDate(d.getUTCDate() - (dow === 0 ? 6 : dow - 1));
  return d.toISOString().slice(0, 10);
}
function weekRangeLabel(mondayIso: string): string {
  const m = new Date(`${mondayIso}T00:00:00Z`);
  const e = new Date(m);
  e.setUTCDate(e.getUTCDate() + 6);
  const d = (x: Date) => x.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${d(m)} – ${d(e)}`;
}
function monthLabelOf(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
function buildWeekOptions(thisMonday: string, back = 6, ahead = 20): { value: string; label: string }[] {
  const base = new Date(`${thisMonday}T00:00:00Z`);
  const out: { value: string; label: string }[] = [];
  for (let i = -back; i <= ahead; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i * 7);
    const value = d.toISOString().slice(0, 10);
    out.push({ value, label: weekRangeLabel(value) + (i === 0 ? ' · this week' : '') });
  }
  return out;
}

type ViewMode = 'lines' | 'product' | 'variant' | 'month';
const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: 'lines', label: 'PO lines' },
  { key: 'product', label: 'By product' },
  { key: 'variant', label: 'By variant' },
  { key: 'month', label: 'By receiving month' },
];

export function ReceivablePlanClient({
  rows,
  editable,
  weekStart,
  weekEnd,
}: {
  rows: ReceivablePlanRow[];
  editable: boolean;
  weekStart: string;
  weekEnd: string;
}) {
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('');
  const [state, setState] = useState('');
  const [oosOnly, setOosOnly] = useState(false);
  const [risk, setRisk] = useState('');
  const [edd, setEdd] = useState<'all' | 'has' | 'week'>('all');
  const [view, setView] = useState<ViewMode>('lines');
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, startSubmit] = useTransition();

  const weekOptions = useMemo(() => buildWeekOptions(weekStart), [weekStart]);

  function submitAll() {
    startSubmit(async () => {
      const res = await submitReceivablePlan();
      setMessage(res.ok ? res.message ?? 'Submitted.' : res.error);
    });
  }

  const vendors = useMemo(
    () => [...new Set(rows.map((r) => r.vendor_name).filter(Boolean))].sort() as string[],
    [rows],
  );
  const states = useMemo(
    () => [...new Set(rows.map((r) => r.product_state).filter(Boolean))].sort() as string[],
    [rows],
  );

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (q &&
        !`${r.po_number} ${r.po_ref_num ?? ''} ${r.product_code ?? ''} ${r.product_variant} ${r.vendor_name ?? ''}`
          .toLowerCase()
          .includes(q)
      ) return false;
      if (vendor && (vendor === BLANK ? Boolean(r.vendor_name) : r.vendor_name !== vendor)) return false;
      if (state && (state === BLANK ? Boolean(r.product_state) : r.product_state !== state)) return false;
      if (risk && r.internal_status !== risk) return false;
      if (oosOnly && !r.oos_flag) return false;
      if (edd === 'has' && !r.expected_delivery_date) return false;
      if (edd === 'week') {
        const d = r.expected_delivery_date;
        if (!d || d < weekStart || d > weekEnd) return false;
      }
      return true;
    });
  }, [rows, search, vendor, state, risk, oosOnly, edd, weekStart, weekEnd]);

  const sort = useColumnSort<ReceivablePlanRow>();
  const oosCount = rows.filter((r) => r.oos_flag).length;

  // Most-recent weekly-input save across all rows — the "last updated" stamp.
  const lastUpdated = useMemo(() => {
    const stamps = rows.map((r) => r.input_updated_at).filter(Boolean) as string[];
    return stamps.length ? stamps.sort().at(-1)!.slice(0, 10) : null;
  }, [rows]);

  return (
    <>
      <Notice tone="info">
        Each row is one colour on an open PO, split by size. Pick the{' '}
        <strong>receiving week</strong> (Mon–Sun) and the <strong>qty expected</strong> for the
        plan — the two editable fields. DOQ, stock and OOS come from the inventory-planning
        snapshot; <strong>Status</strong> is the live TNA risk. Use <strong>View</strong> to see
        the plan by product, variant or receiving month.
        {lastUpdated && (
          <> Weekly plan last updated <strong>{lastUpdated}</strong>.</>
        )}
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}

      <div className="wf-toolbar wf-filter-bar">
        <input
          className="wf-search"
          placeholder="Filter PO / product / vendor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select value={vendor} onChange={(e) => setVendor(e.target.value)} aria-label="Vendor">
          <option value="">All vendors</option>
          <option value={BLANK}>—</option>
          {vendors.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        <select value={state} onChange={(e) => setState(e.target.value)} aria-label="Product state">
          <option value="">All states</option>
          <option value={BLANK}>—</option>
          {states.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <select value={risk} onChange={(e) => setRisk(e.target.value)} aria-label="TNA risk status">
          <option value="">All statuses</option>
          <option value="Overdue">Overdue</option>
          <option value="High Risk">High Risk</option>
          <option value="On Track">On Track</option>
        </select>
        <select value={edd} onChange={(e) => setEdd(e.target.value as 'all' | 'has' | 'week')} aria-label="Delivery">
          <option value="all">Any delivery</option>
          <option value="has">Has EDD</option>
          <option value="week">Arriving this week</option>
        </select>
        <label className="wf-check">
          <input type="checkbox" checked={oosOnly} onChange={(e) => setOosOnly(e.target.checked)} />
          OOS only
        </label>
        <span className="wf-chip">
          {shown.length} rows
          {oosCount > 0 && <em className="wf-chip-warn">{oosCount} OOS</em>}
        </span>
        {editable && view === 'lines' && (
          <button
            type="button"
            className="wf-btn wf-btn-primary wf-btn-sm"
            disabled={submitting}
            onClick={submitAll}
          >
            {submitting ? 'Submitting…' : 'Submit week for approval'}
          </button>
        )}
      </div>

      <div className="segment tracker-status-tabs">
        {VIEW_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={view === t.key ? 'active' : ''}
            onClick={() => setView(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {view === 'lines' ? (
        <div className="table-panel wf-grid-panel">
          <div className="table-scroll">
            <table className="wide-table wf-grid">
              <thead>
                <tr>
                  <th {...sort.th('po', (r) => r.po_number || r.po_ref_num || '')}>PO {sort.ind('po')}</th>
                  <th {...sort.th('product', (r) => r.product_code || r.product_variant)}>Product / colour {sort.ind('product')}</th>
                  <th {...sort.th('vendor', (r) => r.vendor_name)}>Vendor {sort.ind('vendor')}</th>
                  <th {...sort.th('status', (r) => r.product_state)}>Status {sort.ind('status')}</th>
                  <th className="num" {...sort.th('arriving', (r) => r.arriving_qty)}>Arriving {sort.ind('arriving')}</th>
                  {SIZE_KEYS.map(([, label]) => (
                    <th key={label} className="num">{label}</th>
                  ))}
                  <th className="num">DOQ</th>
                  <th className="num" {...sort.th('stock', (r) => r.current_stock)}>Stock {sort.ind('stock')}</th>
                  <th className="num">Sizes in stock</th>
                  <th>OOS</th>
                  <th className="num" {...sort.th('edd', (r) => r.expected_delivery_date ?? '')}>EDD {sort.ind('edd')}</th>
                  <th className="input-col">Receiving week</th>
                  <th className="num input-col">Qty expected</th>
                  {editable && <th aria-label="Save" />}
                </tr>
              </thead>
              <tbody>
                {sort.apply(shown).map((row) => (
                  <ReceivableRow
                    key={row.row_key}
                    row={row}
                    editable={editable}
                    weekOptions={weekOptions}
                    onSaved={() => setMessage('Saved.')}
                  />
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={editable ? 22 : 21} className="wf-empty-cell">
                      No open receivables match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <GroupedView rows={shown} mode={view} />
      )}
    </>
  );
}

/* ---- Read-only rollups: by product / variant / receiving month ---- */
function GroupedView({ rows, mode }: { rows: ReceivablePlanRow[]; mode: Exclude<ViewMode, 'lines'> }) {
  const groups = useMemo(() => {
    type G = {
      key: string;
      label: string;
      sub: string;
      pos: Set<string>;
      variants: Set<string>;
      arriving: number;
      planned: number;
      oos: number;
      rows: number;
    };
    const map = new Map<string, G>();
    for (const r of rows) {
      let key: string;
      let label: string;
      let sub: string;
      if (mode === 'product') {
        key = (r.product_code ?? '—').toUpperCase();
        label = r.product_code ?? '—';
        sub = r.product_state ?? '';
      } else if (mode === 'variant') {
        key = r.product_variant;
        label = r.product_variant;
        sub = r.product_code ?? '';
      } else {
        // by receiving month — month of the planned receiving week; else unscheduled.
        const d = r.delivery_date_this_week;
        key = d ? monthLabelOf(d) : 'Unscheduled';
        label = key;
        sub = d ? '' : 'no receiving week set';
      }
      let g = map.get(key);
      if (!g) {
        g = { key, label, sub, pos: new Set(), variants: new Set(), arriving: 0, planned: 0, oos: 0, rows: 0 };
        map.set(key, g);
      }
      g.pos.add(r.po_number);
      g.variants.add(r.product_variant);
      g.arriving += r.arriving_qty || 0;
      g.planned += Number(r.qty_expected_this_week) || 0;
      if (r.oos_flag) g.oos += 1;
      g.rows += 1;
    }
    const arr = [...map.values()];
    // Month view sorts chronologically (Unscheduled last); others by arriving qty.
    if (mode === 'month') {
      arr.sort((a, b) => {
        if (a.key === 'Unscheduled') return 1;
        if (b.key === 'Unscheduled') return -1;
        return new Date(`1 ${a.key}`).getTime() - new Date(`1 ${b.key}`).getTime();
      });
    } else {
      arr.sort((a, b) => b.arriving - a.arriving);
    }
    return arr;
  }, [rows, mode]);

  const totals = groups.reduce(
    (t, g) => ({ arriving: t.arriving + g.arriving, planned: t.planned + g.planned, oos: t.oos + g.oos }),
    { arriving: 0, planned: 0, oos: 0 },
  );

  const head =
    mode === 'product' ? 'Product' : mode === 'variant' ? 'Variant' : 'Receiving month';

  return (
    <div className="table-panel wf-grid-panel">
      <div className="table-scroll">
        <table className="wf-grid">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="num">POs</th>
              {mode === 'product' && <th className="num">Variants</th>}
              <th className="num">Arriving qty</th>
              <th className="num">Planned qty</th>
              <th className="num">% planned</th>
              <th className="num">OOS lines</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td>
                  <span className={mode === 'month' ? undefined : 'mono'}>{g.label}</span>
                  {g.sub && <small className="wf-subtle">{g.sub}</small>}
                </td>
                <td className="num">{fmt.format(g.pos.size)}</td>
                {mode === 'product' && <td className="num">{fmt.format(g.variants.size)}</td>}
                <td className="num strong">{fmt.format(g.arriving)}</td>
                <td className="num">{g.planned ? fmt.format(g.planned) : '—'}</td>
                <td className="num">
                  {g.arriving > 0 ? `${Math.round((g.planned / g.arriving) * 100)}%` : '—'}
                </td>
                <td className="num">{g.oos ? <span className="wf-over-tag">{g.oos}</span> : '—'}</td>
              </tr>
            ))}
            {!groups.length && (
              <tr>
                <td colSpan={mode === 'product' ? 7 : 6} className="wf-empty-cell">No rows match.</td>
              </tr>
            )}
          </tbody>
          {groups.length > 0 && (
            <tfoot>
              <tr>
                <td><strong>TOTAL</strong></td>
                <td className="num" />
                {mode === 'product' && <td className="num" />}
                <td className="num"><strong>{fmt.format(totals.arriving)}</strong></td>
                <td className="num"><strong>{totals.planned ? fmt.format(totals.planned) : '—'}</strong></td>
                <td className="num">
                  <strong>{totals.arriving > 0 ? `${Math.round((totals.planned / totals.arriving) * 100)}%` : '—'}</strong>
                </td>
                <td className="num"><strong>{totals.oos || '—'}</strong></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function ReceivableRow({
  row,
  editable,
  weekOptions,
  onSaved,
}: {
  row: ReceivablePlanRow;
  editable: boolean;
  weekOptions: { value: string; label: string }[];
  onSaved: () => void;
}) {
  // Stored value is a date; snap to its Monday so it matches a week option.
  const initialWeek = row.delivery_date_this_week ? mondayOf(row.delivery_date_this_week) : '';
  const [week, setWeek] = useState(initialWeek);
  const [qty, setQty] = useState(row.qty_expected_this_week?.toString() ?? '');
  const [pending, start] = useTransition();

  const dirty = week !== initialWeek || qty !== (row.qty_expected_this_week?.toString() ?? '');

  // Week options plus the row's own week if it falls outside the generated range.
  const options = useMemo(() => {
    if (week && !weekOptions.some((o) => o.value === week)) {
      return [{ value: week, label: weekRangeLabel(week) }, ...weekOptions];
    }
    return weekOptions;
  }, [week, weekOptions]);

  // % of the arriving qty covered by what's planned to land.
  const arriving = row.arriving_qty || 0;
  const qtyNum = Number(qty) || 0;
  const pctComplete = arriving > 0 ? Math.round((qtyNum / arriving) * 100) : null;

  const totalSizes = SIZE_KEYS.filter(([k]) => row[k]).length;
  const inStockSizes = SIZE_KEYS.filter(([k]) => (row.stock_by_size?.[k] ?? 0) > 0).length;

  function save() {
    const fd = new FormData();
    fd.set('row_key', row.row_key);
    fd.set('delivery_date_this_week', week); // Monday of the chosen receiving week
    fd.set('qty_expected_this_week', qty);
    start(async () => {
      const res = await saveReceivableInput(fd);
      if (res.ok) onSaved();
    });
  }

  return (
    <tr className={row.oos_flag ? 'wf-row-over' : ''}>
      <td className="mono wf-po-primary">
        <strong>{row.po_number}</strong>
        <small className="wf-subtle">{row.po_ref_num}</small>
      </td>
      <td>
        <span className="mono">{row.product_variant}</span>
        <small className="wf-subtle">{row.product_state ?? row.product_code}</small>
      </td>
      <td>{row.vendor_name || row.vendor_code || '—'}</td>
      <td>
        {row.internal_status ? (
          <span className={`badge ${statusTone(row.internal_status)}`}>
            {row.internal_status}
          </span>
        ) : '—'}
        {row.po_status && <small className="wf-subtle">{row.po_status}</small>}
      </td>
      <td className="num strong">{fmt.format(row.arriving_qty)}</td>
      {SIZE_KEYS.map(([key]) => {
        const stock = row.stock_by_size?.[key];
        return (
          <td key={key} className="num wf-size-cell">
            <span className="wf-size-arr">{cell(row[key])}</span>
            <small className="wf-size-stk">{stock ? fmt.format(stock) : ''}</small>
          </td>
        );
      })}
      <td className="num">{row.doq_45 != null ? row.doq_45 : '—'}</td>
      <td className="num">{row.current_stock != null ? fmt.format(row.current_stock) : '—'}</td>
      <td className="num">
        {totalSizes ? (
          <span className={inStockSizes < totalSizes ? 'wf-over-tag' : ''}>
            {inStockSizes}/{totalSizes}
          </span>
        ) : '—'}
      </td>
      <td>{row.oos_flag ? <span className="wf-over-tag">OOS</span> : ''}</td>
      <td className="num wf-subtle">{row.expected_delivery_date ?? '—'}</td>
      <td className="input-col">
        <select value={week} disabled={!editable} onChange={(e) => setWeek(e.target.value)}>
          <option value="">— pick week —</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </td>
      <td className="num input-col">
        <input
          type="number"
          min={0}
          value={qty}
          disabled={!editable}
          onChange={(e) => setQty(e.target.value)}
        />
        <small className="wf-subtle wf-qty-meta">
          {pctComplete != null && <span>{pctComplete}% of arriving</span>}
          {row.input_updated_at && (
            <span>updated {row.input_updated_at.slice(0, 10)}</span>
          )}
        </small>
      </td>
      {editable && (
        <td>
          <button
            type="button"
            className="wf-btn wf-btn-ghost wf-btn-sm"
            disabled={!dirty || pending}
            onClick={save}
          >
            <Save size={13} /> Save
          </button>
        </td>
      )}
    </tr>
  );
}
