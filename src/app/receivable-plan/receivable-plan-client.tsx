'use client';

import { useMemo, useState, useTransition, useEffect } from 'react';
import Link from 'next/link';
import { HeaderInfo } from '@/components/header-info';
import { Save } from 'lucide-react';
import { useColumnSort } from '@/lib/use-column-sort';
import { decideApproval, saveReceivableInput, submitReceivablePlan } from '@/lib/forms/actions';
import { STATUS_LABEL, canApprove, statusText } from '@/lib/forms/approval';
import { Notice } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { reloadWithToast, toastError } from '@/lib/toast';
import type { ReceivablePlanRow, SdRole } from '@/lib/forms/types';
import type { ArrivalRow } from '@/lib/forms/queries-modules/inward-receivable';
import type { InwardPlanSheetRow } from '@/lib/forms/queries-modules/inward-plan-sheet';
import { ArrivalsClient } from '@/app/arrivals/arrivals-client';
import { InwardPlanSheet } from './inward-plan-sheet';

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
// Approval status → .badge tone (success/warn/danger). Draft is neutral (no tone).
const approvalTone = (s: string): string =>
  s === 'approved' ? 'success' : s === 'rejected' ? 'danger' : s === 'draft' ? '' : 'warn';

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
function firstOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}
function buildMonthOptions(thisMonday: string, back = 1, ahead = 8): { value: string; label: string }[] {
  const base = new Date(`${firstOfMonth(thisMonday)}T00:00:00Z`);
  const thisMonthValue = firstOfMonth(thisMonday);
  const out: { value: string; label: string }[] = [];
  for (let i = -back; i <= ahead; i++) {
    const d = new Date(base);
    d.setUTCMonth(d.getUTCMonth() + i);
    const value = d.toISOString().slice(0, 10);
    out.push({ value, label: monthLabelOf(value) + (value === thisMonthValue ? ' · this month' : '') });
  }
  return out;
}

type ViewMode = 'lines' | 'product' | 'variant' | 'month';
/** How the PO lines are laid out: the editable table, cards, or a board by input stage. */
type LinesLayout = 'list' | 'cards' | 'kanban';
type InputStage = 'none' | 'draft' | 'waiting' | 'approved' | 'back';
const INPUT_STAGES: { key: InputStage; label: string; hint: string; tone: string }[] = [
  { key: 'none', label: 'Not planned', hint: 'No week / month or quantity yet', tone: '' },
  { key: 'draft', label: 'Draft', hint: 'Saved, not submitted', tone: 'info' },
  { key: 'waiting', label: 'Awaiting approval', hint: 'Submitted to the approver', tone: 'warn' },
  { key: 'approved', label: 'Approved', hint: 'Plan accepted', tone: 'success' },
  { key: 'back', label: 'Sent back', hint: 'Rework or rejected', tone: 'danger' },
];
function inputStage(r: ReceivablePlanRow): InputStage {
  switch (r.input_status) {
    case 'approved': return 'approved';
    case 'submitted':
    case 'pending_l2': return 'waiting';
    case 'rework':
    case 'rejected': return 'back';
    default:
      return r.delivery_date_this_week || r.qty_expected_this_week ? 'draft' : 'none';
  }
}
const VIEW_TABS: { key: ViewMode; label: string }[] = [
  { key: 'lines', label: 'PO lines' },
  { key: 'product', label: 'By product' },
  { key: 'variant', label: 'By variant' },
  { key: 'month', label: 'By receiving month' },
];

export function ReceivablePlanClient({
  rows,
  arrivals = [],
  editable,
  weekStart,
  weekEnd,
  sheet = [],
  sheetMonths = [],
  role = 'viewer',
  initialTab = 'arrivals',
  initialMonth = null,
  today,
}: {
  rows: ReceivablePlanRow[];
  /** Rows for the Arrivals tab — same data the standalone Arrivals page reads. */
  arrivals?: ArrivalRow[];
  editable: boolean;
  weekStart: string;
  weekEnd: string;
  /** The team's monthly inward sheet (Monthly plan tab). */
  sheet?: InwardPlanSheetRow[];
  sheetMonths?: string[];
  role?: SdRole;
  initialTab?: 'arrivals' | 'input' | 'monthly' | 'lines';
  initialMonth?: string | null;
  /** YYYY-MM-DD, from the server. */
  today: string;
}) {
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('');
  const [state, setState] = useState('');
  const [oosOnly, setOosOnly] = useState(false);
  const [risk, setRisk] = useState('');
  const [edd, setEdd] = useState<'all' | 'has' | 'week'>('all');
  const [view, setView] = useState<ViewMode>('lines');
  // Input works on PO lines only; the rollups are for reading.
  const viewTabs = initialTab === 'input' ? [] : VIEW_TABS;
  /* Two screens. View is the read: arrivals against the plan, the monthly sheet, and the plan
     lines by PO, product, variant or receiving month — nothing editable. Input is the write:
     the team enters quantity and week per PO line and submits; the approver decides there. */
  const screen: 'view' | 'input' = initialTab === 'input' ? 'input' : 'view';
  const [tab, setTab] = useState<'arrivals' | 'monthly' | 'lines'>(initialTab === 'input' ? 'lines' : initialTab);
  const [message, setMessage] = useState<string | null>(null);
  const [submitRemark, setSubmitRemark] = useState('');
  // An approver opens on the rows waiting for their decision; "All rows" shows the rest.
  const isApprover = canApprove(role, 'submitted');
  const canInput = editable || isApprover;
  // Editing and deciding happen on the Input screen only; View is read-only for everyone.
  const linesEditable = screen === 'input' && editable;
  const decides = screen === 'input' && isApprover;
  const [needsMine, setNeedsMine] = useState(() => decides && rows.some((r) => r.input_status === 'submitted'));
  // PO lines come in pages so the table is not one long scroll.
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState<LinesLayout>('list');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ip-lines-layout');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage on mount
      if (saved === 'list' || saved === 'cards' || saved === 'kanban') setLayout(saved);
    } catch {
      /* storage blocked: keep list */
    }
  }, []);
  const chooseLayout = (l: LinesLayout) => {
    setLayout(l);
    try { localStorage.setItem('ip-lines-layout', l); } catch { /* ignore */ }
  };
  /** Cards and Kanban are for reading; "Edit" opens the row in the list, filtered to it. */
  const editInList = (r: ReceivablePlanRow) => {
    setSearch(`${r.po_ref_num || r.po_number} ${r.product_variant}`.trim());
    chooseLayout('list');
  };
  const [pageSize, setPageSize] = useState(50);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- back to page 1 whenever the filters change
    setPage(0);
  }, [search, vendor, state, risk, oosOnly, edd, needsMine]);
  const [submitting, startSubmit] = useTransition();

  const weekOptions = useMemo(() => buildWeekOptions(weekStart), [weekStart]);
  const monthOptions = useMemo(() => buildMonthOptions(weekStart), [weekStart]);

  function submitAll() {
    startSubmit(async () => {
      const res = await submitReceivablePlan(submitRemark);
      setMessage(res.ok ? res.message ?? 'Submitted.' : res.error);
      if (res.ok) setSubmitRemark('');
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
      if (needsMine && r.input_status !== 'submitted') return false;
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
  }, [rows, search, vendor, state, risk, oosOnly, edd, weekStart, weekEnd, needsMine]);

  const sort = useColumnSort<ReceivablePlanRow>();
  const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
  const pageNo = Math.min(page, pageCount - 1);
  const pageFrom = pageNo * pageSize;
  const pageTo = Math.min(shown.length, pageFrom + pageSize);
  const pagerEl =
    shown.length > 25 ? (
      <div className="pager rp-pager">
                <label className="rp-pager-size">
                  Rows per page
                  <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} aria-label="Rows per page">
                    {[25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </label>
                <span>{pageFrom + 1}–{pageTo} of {shown.length} rows · page {pageNo + 1} of {pageCount}</span>
                <button type="button" disabled={pageNo <= 0} onClick={() => setPage(0)} aria-label="First page">«</button>
                <button type="button" disabled={pageNo <= 0} onClick={() => setPage(pageNo - 1)}>Prev</button>
                <button type="button" disabled={pageNo >= pageCount - 1} onClick={() => setPage(pageNo + 1)}>Next</button>
                <button type="button" disabled={pageNo >= pageCount - 1} onClick={() => setPage(pageCount - 1)} aria-label="Last page">»</button>
              </div>
    ) : null;
  const oosCount = rows.filter((r) => r.oos_flag).length;
  const submittedCount = rows.filter((r) => r.input_status === 'submitted').length;

  // Most-recent weekly-input save across all rows — the "last updated" stamp.
  const lastUpdated = useMemo(() => {
    const stamps = rows.map((r) => r.input_updated_at).filter(Boolean) as string[];
    return stamps.length ? stamps.sort().at(-1)!.slice(0, 10) : null;
  }, [rows]);

  return (
    <>
      <nav className="ip-screens" aria-label="Inward Plan screens">
        <Link href={`/receivable-plan?tab=${tab === 'lines' && screen === 'input' ? 'monthly' : tab}${initialMonth ? `&month=${initialMonth}` : ''}`} className={screen === 'view' ? 'active' : ''} aria-current={screen === 'view' ? 'page' : undefined}>
          View inward plan
        </Link>
        {canInput && (
          <Link href="/receivable-plan?tab=input" className={screen === 'input' ? 'active' : ''} aria-current={screen === 'input' ? 'page' : undefined}>
            Input inward plan
          </Link>
        )}
      </nav>

      {screen === 'view' && (
        <div className="segment ip-tabs" role="tablist" aria-label="Inward Plan views">
          {([['arrivals', 'Arrivals'], ['monthly', 'Monthly plan'], ['lines', 'Plan lines']] as const).map(([k, label]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'arrivals' ? (
        <ArrivalsClient rows={arrivals} />
      ) : tab === 'monthly' ? (
        <InwardPlanSheet rows={sheet} role={role} monthOptions={sheetMonths} initialMonth={initialMonth} arrivals={arrivals} today={today} />
      ) : (
      <>
      {screen === 'view' ? (
      <Notice tone="info">
        The plan as entered, read-only: one row per colour on an open PO with the receiving week or
        month and the quantity expected. Use <strong>View</strong> to see it by product, variant or
        receiving month. To change it, open <strong>Input inward plan</strong>.
        {lastUpdated && (
          <> Weekly plan last updated <strong>{lastUpdated}</strong>.</>
        )}
      </Notice>
      ) : (
      <Notice tone="info">
        Each row is one colour on an open PO, split by size. Pick when it&rsquo;s expected — either a{' '}
        <strong>whole month</strong> or a specific <strong>week</strong> (Mon–Sun), whichever you
        know — and the <strong>qty expected</strong>, then submit for approval. <strong>Once a
        month is approved</strong> you can switch to any week within it without re-approval; filling
        a week directly, changing the quantity, or moving to another month needs approval again.
        DOQ, stock and OOS come from the inventory-planning snapshot; <strong>Status</strong> is the
        live TNA risk. To read the plan by product, variant or receiving month, open{' '}
        <strong>View inward plan</strong>.
        {lastUpdated && (
          <> Weekly plan last updated <strong>{lastUpdated}</strong>.</>
        )}
      </Notice>
      )}

      {/* The approver decides the submitted week here as well as on Approvals — the
          same batch decision, so "Open record" never lands on a page with nothing to press. */}
      {decides && submittedCount > 0 && (
        <section className="wf-queue-card wf-queue-card-wide sc-decision" aria-label="Your decision">
          <div className="wf-queue-head">
            <div>
              <h3>Decide the submitted week — {submittedCount} row(s)</h3>
              <p className="wf-subtle">
                Approve, send back or reject every row the team submitted for this week at once. Rows
                approved by month can then be moved to any week inside it without another approval.
              </p>
            </div>
          </div>
          <ApprovalBar
            entityType="receivable_plan"
            entityId="batch"
            entityLabel={`Receivable plan — ${submittedCount} row(s)`}
            onDone={(result) => { if (result.ok) reloadWithToast(result.message ?? 'Saved.'); }}
          />
        </section>
      )}

      {message && <Notice tone="ok">{message}</Notice>}

      <div className="wf-toolbar wf-filter-bar">
        {decides && (
          <div className="segment fb-seg" role="group" aria-label="Show">
            <button type="button" className={needsMine ? 'active' : ''} aria-pressed={needsMine} onClick={() => setNeedsMine(true)}>
              Needs approval ({submittedCount})
            </button>
            <button type="button" className={!needsMine ? 'active' : ''} aria-pressed={!needsMine} onClick={() => setNeedsMine(false)}>
              All rows
            </button>
          </div>
        )}
        <input
          className="wf-search"
          placeholder="Search PO, product or vendor…"
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
          {oosCount > 0 && (
            <em className="wf-chip-warn">{oosCount} ran out at some point in the last 45 days</em>
          )}
        </span>
      </div>

      <div className="ip-viewrow">
        {viewTabs.length > 0 ? (
          <div className="segment tracker-status-tabs">
            {viewTabs.map((t) => (
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
        ) : <span />}
        <div className="segment ip-layout-seg" role="group" aria-label="Layout">
          {(['list', 'cards', 'kanban'] as LinesLayout[]).map((l) => (
            <button key={l} type="button" className={layout === l ? 'active' : ''} aria-pressed={layout === l} onClick={() => chooseLayout(l)}>
              {l === 'list' ? 'List' : l === 'cards' ? 'Cards' : 'Kanban'}
            </button>
          ))}
        </div>
      </div>

      {view === 'lines' && layout !== 'list' ? (
        <>
          <LinesBoard
            rows={sort.apply(shown)}
            layout={layout}
            pageFrom={pageFrom}
            pageTo={pageTo}
            editable={linesEditable}
            onEdit={editInList}
            canDecide={decides}
          />
          {layout === 'cards' && pagerEl}
        </>
      ) : view === 'lines' ? (
        <div className="table-panel wf-grid-panel">
          <div className="table-scroll">
            <table className="wide-table wf-grid">
              {/* Two header rows. A size cell carries two numbers, and a tooltip is no use to
                  someone who does not know there is anything to hover over — so the meaning
                  sits in a heading spanning the size columns, visible without any action. */}
              <thead>
                <tr>
                  <th rowSpan={2} {...sort.th('po', (r) => r.po_number || r.po_ref_num || '')}>PO {sort.ind('po')}</th>
                  <th rowSpan={2} {...sort.th('product', (r) => r.product_code || r.product_variant)}>Product / colour {sort.ind('product')}</th>
                  <th rowSpan={2} {...sort.th('vendor', (r) => r.vendor_name)}>Vendor {sort.ind('vendor')}</th>
                  <th rowSpan={2} {...sort.th('status', (r) => r.product_state)}>Status {sort.ind('status')}</th>
                  <th rowSpan={2} className="num" {...sort.th('arriving', (r) => r.arriving_qty)}>Arriving {sort.ind('arriving')}</th>
                  <th colSpan={SIZE_KEYS.length} className="rp-size-group">
                    By size: <b>arriving on this PO</b>
                    <span className="rp-size-group-stock">
                      stock from last night&rsquo;s sync, all five warehouses
                    </span>
                  </th>
                  <th rowSpan={2} className="num">DOQ</th>
                  <th rowSpan={2} className="num" {...sort.th('stock', (r) => r.current_stock)}>
                    Stock, all warehouses {sort.ind('stock')}
                  </th>
                  <th rowSpan={2} className="num">Sizes in stock</th>
                  <th rowSpan={2}>Ran out in last 45 days</th>
                  <th rowSpan={2} className="num" {...sort.th('edd', (r) => r.expected_delivery_date ?? '')}>EDD {sort.ind('edd')}</th>
                  <th rowSpan={2} className="input-col">Receiving week / month</th>
                  <th rowSpan={2} className="num input-col">Qty expected</th>
                  {linesEditable && <th rowSpan={2} aria-label="Save" />}
                </tr>
                <tr>
                  {SIZE_KEYS.map(([, label]) => (
                    <th key={label} className="num rp-size-head">{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sort.apply(shown).map((row, i) => (
                  <ReceivableRow
                    key={row.row_key}
                    row={row}
                    editable={linesEditable}
                    weekOptions={weekOptions}
                    monthOptions={monthOptions}
                    onSaved={() => setMessage('Saved.')}
                    hidden={i < pageFrom || i >= pageTo}
                  />
                ))}
                {!shown.length && (
                  <tr>
                    <td colSpan={linesEditable ? 22 : 21} className="wf-empty-cell">
                      No open receivables match.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {layout === 'list' && pagerEl}
        </div>
      ) : (
        <GroupedView
          rows={shown}
          mode={view}
          layout={layout}
          onOpenLines={(q) => { setSearch(q); setView('lines'); }}
          canDecide={decides}
        />
      )}

      {/* Submit sits after the PO lines: fill the rows first, then send the week. */}
      {linesEditable && view === 'lines' && (
        <div className="rp-submit">
          <div className="rp-submit-text">
            <b>Submit for approval</b>
            <span>Sends every row you filled this week to the approver. Add a remark if something needs explaining.</span>
          </div>
          <input
            className="rp-submit-remark"
            placeholder="Remark for the approver (optional)"
            value={submitRemark}
            onChange={(e) => setSubmitRemark(e.target.value)}
            aria-label="Remark for the approver"
          />
          <button type="button" className="wf-btn wf-btn-primary" disabled={submitting} onClick={submitAll}>
            {submitting ? 'Submitting…' : 'Submit week for approval'}
          </button>
        </div>
      )}
      </>
      )}
    </>
  );
}

/* ---- Read-only rollups: by product / variant / receiving month ---- */
function GroupedView({
  rows,
  mode,
  layout = 'list',
  onOpenLines,
  canDecide = false,
}: {
  rows: ReceivablePlanRow[];
  mode: Exclude<ViewMode, 'lines'>;
  layout?: LinesLayout;
  /** Open the PO lines filtered to a product / variant. */
  onOpenLines?: (query: string) => void;
  /** The approver may decide a group's submitted lines from its card. */
  canDecide?: boolean;
}) {
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
      /** Lines in this group waiting for the approver. */
      submitted: string[];
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
        g = { key, label, sub, pos: new Set(), variants: new Set(), arriving: 0, planned: 0, oos: 0, rows: 0, submitted: [] };
        map.set(key, g);
      }
      g.pos.add(r.po_number);
      g.variants.add(r.product_variant);
      g.arriving += r.arriving_qty || 0;
      g.planned += Number(r.qty_expected_this_week) || 0;
      if (r.oos_flag) g.oos += 1;
      if (r.input_status === 'submitted') g.submitted.push(r.row_key);
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

  type Group = (typeof groups)[number];
  const pctOf = (g: Group) => (g.arriving > 0 ? Math.round((g.planned / g.arriving) * 100) : 0);
  const card = (g: Group) => {
    const pct = pctOf(g);
    return (
      <article key={g.key} className={`ip-card${g.oos ? ' is-oos' : ''}`}>
        <div className="ip-card-top">
          <span className="ip-card-po">{head}</span>
          {g.oos > 0 && <span className="badge danger">{g.oos} OOS</span>}
        </div>
        <b className={`ip-card-name${mode === 'month' ? '' : ' mono'}`}>{g.label}</b>
        {g.sub && <span className="ip-card-meta">{g.sub}</span>}
        <div className="ip-card-figs">
          <span><small>POs</small>{fmt.format(g.pos.size)}</span>
          <span><small>Arriving</small>{fmt.format(g.arriving)}</span>
          <span><small>Planned</small>{g.planned ? fmt.format(g.planned) : '—'}</span>
        </div>
        <span className="ip-card-bar" aria-label={`${pct}% planned`}><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
        <div className="ip-card-foot">
          <span className="ip-card-when">{g.arriving > 0 ? `${pct}% planned` : 'Nothing arriving'}{mode === 'product' ? ` · ${g.variants.size} variant${g.variants.size === 1 ? '' : 's'}` : ''}</span>
        </div>
        {canDecide && g.submitted.length > 0 && (
          <CardDecision rowKeys={g.submitted} what={`${head} ${g.label}`} label={`Receivable plan — ${head.toLowerCase()} ${g.label} (${g.submitted.length} line${g.submitted.length === 1 ? '' : 's'})`} />
        )}
        {onOpenLines && mode !== 'month' && (
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm ip-card-edit" onClick={() => onOpenLines(g.label)}>
            Show PO lines
          </button>
        )}
      </article>
    );
  };

  if (layout === 'cards') {
    return groups.length ? <div className="ip-cards">{groups.map(card)}</div> : <p className="wf-empty-cell ip-empty">No rows match.</p>;
  }
  if (layout === 'kanban') {
    const COVER: { key: string; label: string; hint: string; tone: string; test: (g: Group) => boolean }[] = [
      { key: 'none', label: 'Not planned', hint: 'Nothing planned yet', tone: 'danger', test: (g) => g.planned <= 0 },
      { key: 'part', label: 'Partly planned', hint: 'Some of the arriving qty planned', tone: 'warn', test: (g) => g.planned > 0 && g.planned < g.arriving },
      { key: 'full', label: 'Fully planned', hint: 'Planned qty covers what is arriving', tone: 'success', test: (g) => g.planned > 0 && g.planned >= g.arriving },
    ];
    const PER_COLUMN = 40;
    return (
      <div className="ip-kanban">
        {COVER.map((c) => {
          const items = groups.filter(c.test);
          return (
            <section key={c.key} className="ip-kcol" aria-label={c.label}>
              <div className="ip-kcol-head">
                <span className={`badge ${c.tone}`}>{c.label}</span>
                <span className="ip-kcol-n">{items.length}</span>
              </div>
              <small className="ip-kcol-hint">{c.hint}</small>
              {items.slice(0, PER_COLUMN).map(card)}
              {items.length > PER_COLUMN && <p className="ip-kcol-more">+{items.length - PER_COLUMN} more — narrow the filters or use List</p>}
              {!items.length && <p className="ip-kcol-more">Nothing here.</p>}
            </section>
          );
        })}
      </div>
    );
  }

  return (
    <div className="table-panel wf-grid-panel">
      <div className="table-scroll">
        <table className="wf-grid">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="num">POs <HeaderInfo label="POs" /></th>
              {mode === 'product' && <th className="num">Variants <HeaderInfo label="Variants" /></th>}
              <th className="num">Arriving qty <HeaderInfo label="Arriving qty" /></th>
              <th className="num">Planned qty <HeaderInfo label="Planned qty" /></th>
              <th className="num">% planned <HeaderInfo label="% planned" /></th>
              <th className="num">OOS lines <HeaderInfo label="OOS lines" /></th>
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

/**
 * The approver's decision on a card: Approve, or Send back / Reject with a remark. Decides
 * only the given rows (one PO line, or a group's submitted lines) through the same approval
 * path as the week's batch decision — approved-month stamping, notifications and the log.
 */
function CardDecision({ rowKeys, label, what }: { rowKeys: string[]; label: string; what: string }) {
  const [mode, setMode] = useState<null | 'rework' | 'reject'>(null);
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  function decide(decision: 'approve' | 'rework' | 'reject') {
    setErr(null);
    if (decision !== 'approve' && !notes.trim()) {
      setErr('Add a remark: the team sees it with the line.');
      return;
    }
    const fd = new FormData();
    fd.set('entity_type', 'receivable_plan');
    fd.set('entity_id', 'rows');
    fd.set('entity_label', label);
    fd.set('decision', decision);
    fd.set('notes', notes.trim());
    fd.set('row_keys', JSON.stringify(rowKeys));
    start(async () => {
      const res = await decideApproval(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setErr(toastError(res.error));
    });
  }
  return (
    <div className="ip-decide" role="group" aria-label={`Decision on ${what}`}>
      <span className="ip-decide-label">Awaiting your decision{rowKeys.length > 1 ? ` · ${rowKeys.length} lines` : ''}</span>
      {mode ? (
        <>
          <textarea
            className="ip-decide-note"
            rows={2}
            autoFocus
            value={notes}
            placeholder={mode === 'rework' ? 'What should the team change?' : 'Why is it rejected?'}
            onChange={(e) => setNotes(e.target.value)}
            aria-label="Remark for the team"
          />
          <div className="ip-decide-actions">
            <button type="button" className={`wf-btn wf-btn-sm ${mode === 'reject' ? 'wf-btn-danger' : 'wf-btn-primary'}`} disabled={pending} onClick={() => decide(mode)}>
              {pending ? 'Working…' : mode === 'rework' ? 'Send back' : 'Reject'}
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => { setMode(null); setNotes(''); setErr(null); }}>Cancel</button>
          </div>
        </>
      ) : (
        <div className="ip-decide-actions">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending} onClick={() => decide('approve')}>
            {pending ? 'Working…' : rowKeys.length > 1 ? `Approve ${rowKeys.length}` : 'Approve'}
          </button>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => setMode('rework')}>Send back</button>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => setMode('reject')}>Reject</button>
        </div>
      )}
      {err && <small className="ip-decide-err" role="alert">{err}</small>}
    </div>
  );
}

/** Where a row is planned to land, in words: a week range or a whole month. */
function pickLabel(r: ReceivablePlanRow): string | null {
  if (!r.delivery_date_this_week) return null;
  return r.receiving_granularity === 'month' ? monthLabelOf(r.delivery_date_this_week) : weekRangeLabel(r.delivery_date_this_week);
}

/** One PO line as a card (Cards and Kanban). Read-only; Edit opens it in the list. */
function LineCard({ row, editable, onEdit, canDecide = false }: { row: ReceivablePlanRow; editable: boolean; onEdit: (r: ReceivablePlanRow) => void; canDecide?: boolean }) {
  const planned = row.qty_expected_this_week ?? 0;
  const pct = row.arriving_qty > 0 ? Math.round((planned / row.arriving_qty) * 100) : null;
  const when = pickLabel(row);
  return (
    <article className={`ip-card${row.oos_flag ? ' is-oos' : ''}`}>
      <div className="ip-card-top">
        <span className="mono ip-card-po">{row.po_ref_num || row.po_number}</span>
        {row.internal_status && <span className={`badge ${statusTone(row.internal_status)}`}>{row.internal_status}</span>}
      </div>
      <b className="ip-card-name">{row.product_variant}</b>
      <span className="ip-card-meta">{row.vendor_name || row.vendor_code || '—'}{row.product_state ? ` · ${row.product_state}` : ''}</span>
      <div className="ip-card-figs">
        <span><small>Arriving</small>{fmt.format(row.arriving_qty)}</span>
        <span><small>Planned</small>{planned ? fmt.format(planned) : '—'}</span>
        <span><small>EDD</small>{row.expected_delivery_date ?? '—'}</span>
      </div>
      {pct != null && (
        <span className="ip-card-bar" aria-label={`${pct}% of arriving qty planned`}><i style={{ width: `${Math.min(100, pct)}%` }} /></span>
      )}
      <div className="ip-card-foot">
        <span className="ip-card-when">{when ? `Expected ${when}` : 'No week / month yet'}</span>
        <span className="ip-card-tags">
          {row.oos_flag && <span className="badge danger">OOS</span>}
          {row.input_status && <span className="ip-card-status">{statusText(row.input_status, { approverEdited: row.input_approver_edited })}</span>}
        </span>
      </div>
      {canDecide && row.input_status === 'submitted' && (
        <CardDecision
          rowKeys={[row.row_key]}
          what={`${row.po_ref_num || row.po_number} ${row.product_variant}`}
          label={`Receivable plan — ${row.po_ref_num || row.po_number} · ${row.product_variant}`}
        />
      )}
      <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm ip-card-edit" onClick={() => onEdit(row)}>
        {editable ? 'Edit in list' : 'Show in list'}
      </button>
    </article>
  );
}

/** PO lines as cards (paged like the list) or as a board by input stage. */
function LinesBoard({
  rows,
  layout,
  pageFrom,
  pageTo,
  editable,
  onEdit,
  canDecide = false,
}: {
  rows: ReceivablePlanRow[];
  layout: 'cards' | 'kanban';
  pageFrom: number;
  pageTo: number;
  editable: boolean;
  onEdit: (r: ReceivablePlanRow) => void;
  canDecide?: boolean;
}) {
  const PER_COLUMN = 40;
  if (!rows.length) return <p className="wf-empty-cell ip-empty">No open receivables match.</p>;
  if (layout === 'cards') {
    return (
      <div className="ip-cards">
        {rows.slice(pageFrom, pageTo).map((r) => <LineCard key={r.row_key} row={r} editable={editable} onEdit={onEdit} canDecide={canDecide} />)}
      </div>
    );
  }
  return (
    <div className="ip-kanban">
      {INPUT_STAGES.map((st) => {
        const items = rows.filter((r) => inputStage(r) === st.key);
        return (
          <section key={st.key} className="ip-kcol" aria-label={st.label}>
            <div className="ip-kcol-head">
              <span className={`badge ${st.tone}`}>{st.label}</span>
              <span className="ip-kcol-n">{items.length}</span>
            </div>
            <small className="ip-kcol-hint">{st.hint}</small>
            {items.slice(0, PER_COLUMN).map((r) => <LineCard key={r.row_key} row={r} editable={editable} onEdit={onEdit} canDecide={canDecide} />)}
            {items.length > PER_COLUMN && (
              <p className="ip-kcol-more">+{items.length - PER_COLUMN} more — narrow the filters or use List</p>
            )}
            {!items.length && <p className="ip-kcol-more">Nothing here.</p>}
          </section>
        );
      })}
    </div>
  );
}

function ReceivableRow({
  row,
  editable,
  weekOptions,
  monthOptions,
  onSaved,
  hidden = false,
}: {
  row: ReceivablePlanRow;
  editable: boolean;
  weekOptions: { value: string; label: string }[];
  monthOptions: { value: string; label: string }[];
  onSaved: () => void;
  /** Off the current page: kept mounted (unsaved typing survives a page change), not shown. */
  hidden?: boolean;
}) {
  // The picker holds a tagged value: `m<date>` = a whole month (1st stored),
  // `w<date>` = a specific week (Monday stored). Empty = unset.
  const initialValue = row.delivery_date_this_week
    ? row.receiving_granularity === 'month'
      ? `m${firstOfMonth(row.delivery_date_this_week)}`
      : `w${mondayOf(row.delivery_date_this_week)}`
    : '';
  const [pick, setPick] = useState(initialValue);
  const [qty, setQty] = useState(row.qty_expected_this_week?.toString() ?? '');
  const [pending, start] = useTransition();

  const dirty = pick !== initialValue || qty !== (row.qty_expected_this_week?.toString() ?? '');

  // Month/week options, plus the row's own pick if it falls outside the ranges.
  const months = useMemo(() => {
    if (pick.startsWith('m')) {
      const d = pick.slice(1);
      if (!monthOptions.some((o) => o.value === d)) {
        return [{ value: d, label: monthLabelOf(d) }, ...monthOptions];
      }
    }
    return monthOptions;
  }, [pick, monthOptions]);
  const weeks = useMemo(() => {
    if (pick.startsWith('w')) {
      const d = pick.slice(1);
      if (!weekOptions.some((o) => o.value === d)) {
        return [{ value: d, label: weekRangeLabel(d) }, ...weekOptions];
      }
    }
    return weekOptions;
  }, [pick, weekOptions]);

  // % of the arriving qty covered by what's planned to land.
  const arriving = row.arriving_qty || 0;
  const qtyNum = Number(qty) || 0;
  const pctComplete = arriving > 0 ? Math.round((qtyNum / arriving) * 100) : null;

  // Approval cue: while a month is approved for this row, any week within it saves
  // without re-approval; a week outside it, a new month, or a qty change won't.
  const approvedMonthLabel = row.approved_month ? monthLabelOf(row.approved_month) : null;
  const qtyUnchanged = qty === (row.qty_expected_this_week?.toString() ?? '');
  const pickMonth = pick ? firstOfMonth(pick.slice(1)) : null;
  // A week is "within" the approved month if its Monday OR its Sunday falls in it
  // (same rule as the server), so boundary weeks qualify for either month.
  const pickSundayMonth = pick.startsWith('w')
    ? (() => {
        const d = new Date(`${pick.slice(1)}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 6);
        return firstOfMonth(d.toISOString().slice(0, 10));
      })()
    : null;
  const staysApproved =
    row.input_status === 'approved' &&
    pick.startsWith('w') &&
    !!row.approved_month &&
    (pickMonth === row.approved_month || pickSundayMonth === row.approved_month) &&
    qtyUnchanged;
  const willNeedApproval = dirty && !staysApproved;

  const totalSizes = SIZE_KEYS.filter(([k]) => row[k]).length;
  const inStockSizes = SIZE_KEYS.filter(([k]) => (row.stock_by_size?.[k] ?? 0) > 0).length;

  function save() {
    const fd = new FormData();
    fd.set('row_key', row.row_key);
    // Tagged pick → date + granularity. `m` stores the 1st; `w` stores the Monday.
    fd.set('delivery_date_this_week', pick ? pick.slice(1) : '');
    fd.set('receiving_granularity', pick.startsWith('m') ? 'month' : 'week');
    fd.set('qty_expected_this_week', qty);
    start(async () => {
      const res = await saveReceivableInput(fd);
      if (res.ok) onSaved();
    });
  }

  return (
    <tr className={row.oos_flag ? 'wf-row-over' : ''} hidden={hidden}>
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
      {SIZE_KEYS.map(([key, label]) => {
        const stock = row.stock_by_size?.[key];
        const arriving = row[key];
        return (
          <td
            key={key}
            className="num wf-size-cell"
            title={`${label} — arriving on this PO: ${arriving ? fmt.format(arriving) : 'none'}; in stock today: ${stock ? fmt.format(stock) : 'none'}`}
          >
            <span className="wf-size-arr">{cell(arriving)}</span>
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
      {/* oos_flag is true when the variant was out of stock on ANY day of the last 45, not
          when it is out of stock today. The column heading carries that meaning, so the cell
          only has to answer it. */}
      <td>{row.oos_flag ? <span className="wf-over-tag">Yes</span> : <span className="wf-subtle">No</span>}</td>
      <td className="num wf-subtle">{row.expected_delivery_date ?? '—'}</td>
      <td className="input-col">
        <select value={pick} disabled={!editable} onChange={(e) => setPick(e.target.value)}>
          <option value="">— pick month / week —</option>
          <optgroup label="Whole month">
            {months.map((o) => (
              <option key={`m${o.value}`} value={`m${o.value}`}>{o.label}</option>
            ))}
          </optgroup>
          <optgroup label="Specific week">
            {weeks.map((o) => (
              <option key={`w${o.value}`} value={`w${o.value}`}>{o.label}</option>
            ))}
          </optgroup>
        </select>
        <small className="wf-subtle wf-qty-meta">
          {row.input_status && (
            <span className={`badge ${approvalTone(row.input_status)}`}>
              {statusText(row.input_status, { approverEdited: row.input_approver_edited })}
            </span>
          )}
          {approvedMonthLabel && <span>weeks free in {approvedMonthLabel}</span>}
          {willNeedApproval && <span className="wf-chip-warn">will need approval</span>}
        </small>
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
