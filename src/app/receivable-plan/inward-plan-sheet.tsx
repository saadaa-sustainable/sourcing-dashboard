'use client';

import { confirmDelete } from '@/lib/confirm';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Upload, Trash2 } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { InfoDot } from '@/components/info-dot';
import { Notice } from '@/components/forms/form-layout';
import { canApprove, canEdit, sheetStatusText } from '@/lib/forms/approval';
import { decideInwardPlanRow, deleteInwardPlanRow, editAndApproveInwardRow, importInwardPlanSheet } from '@/lib/forms/actions';
import { reloadWithToast, toastError } from '@/lib/toast';
import type { SdRole } from '@/lib/forms/types';
import type { InwardPlanSheetRow } from '@/lib/forms/queries-modules/inward-plan-sheet';
import type { ArrivalRow } from '@/lib/forms/queries-modules/inward-receivable';
import { InwardWeekBoard } from './inward-week-board';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const monthLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateLabel = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

const STATUS_TONE: Record<string, string> = { Approved: 'success', Rejected: 'danger', 'RE-WORK': 'warn', Pending: 'info' };
const STATUSES = ['Pending', 'Approved', 'RE-WORK', 'Rejected'] as const;
/** Kanban reads left to right as the line moves: waiting → sent back → approved → rejected. */
const KANBAN = ['Pending', 'RE-WORK', 'Approved', 'Rejected'] as const;

function StatusPill({ status, approverEdited }: { status: string; approverEdited?: boolean }) {
  // The sheet stores Pending / Approved / RE-WORK / Rejected; shown in the workflow's words.
  const text = sheetStatusText(status, { approverEdited });
  return <span className={`badge ${STATUS_TONE[status] ?? ''}`}>{text}</span>;
}

/**
 * The team's monthly inward sheet, month by month: what they said would come in,
 * whether the approver has signed it off, and what has actually landed against it.
 */
export function InwardPlanSheet({
  rows,
  role,
  monthOptions,
  initialMonth,
  arrivals = [],
  today,
}: {
  rows: InwardPlanSheetRow[];
  role: SdRole;
  monthOptions: string[];
  initialMonth: string | null;
  /** Receivable-plan expectations, for the week board. */
  arrivals?: ArrivalRow[];
  /** YYYY-MM-DD, from the server. */
  today: string;
}) {
  const defaultMonth = initialMonth && monthOptions.includes(initialMonth) ? initialMonth : rows[0]?.plan_month ?? monthOptions[0];
  const [month, setMonth] = useState<string>(defaultMonth);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [board, setBoard] = useState<'weeks' | 'vendors' | 'lines'>('weeks');
  // Lines as a List (the table), Cards or Kanban by status; the choice is remembered per browser.
  const [layout, setLayout] = useState<'list' | 'cards' | 'kanban'>('list');
  const [query, setQuery] = useState('');
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ip-sheet-layout');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage on mount
      if (saved === 'list' || saved === 'cards' || saved === 'kanban') setLayout(saved);
    } catch {
      /* storage blocked: keep list */
    }
  }, []);
  const chooseLayout = (l: 'list' | 'cards' | 'kanban') => {
    setLayout(l);
    try { localStorage.setItem('ip-sheet-layout', l); } catch { /* ignore */ }
  };

  const monthRows = useMemo(() => rows.filter((r) => r.plan_month === month), [rows, month]);
  const shown = useMemo(
    () => (statusFilter === 'all' ? monthRows : monthRows.filter((r) => r.approval_status === statusFilter)),
    [monthRows, statusFilter],
  );
  // Cards and Kanban have no table search of their own: one box over product, PO ref, vendor.
  const matches = (r: InwardPlanSheetRow) => {
    const q = query.trim().toLowerCase();
    return !q || `${r.product_code} ${r.po_no ?? ''} ${r.vendor_name ?? ''} ${r.category ?? ''}`.toLowerCase().includes(q);
  };
  const searched = shown.filter(matches);
  // Kanban columns are the statuses, so it ignores the status pills above.
  const searchedAll = monthRows.filter(matches);

  const totals = useMemo(() => {
    const t = { lines: monthRows.length, qty: 0, value: 0, approvedQty: 0, approvedValue: 0, received: 0, by: {} as Record<string, number> };
    for (const r of monthRows) {
      t.qty += r.inward_qty ?? 0;
      t.value += r.value;
      t.received += r.received_in_month;
      if (r.approval_status === 'Approved') { t.approvedQty += r.inward_qty ?? 0; t.approvedValue += r.value; }
      t.by[r.approval_status] = (t.by[r.approval_status] ?? 0) + 1;
    }
    return t;
  }, [monthRows]);
  const pendingCount = totals.by.Pending ?? 0;
  const approver = canApprove(role, 'pending_l2');
  const editor = canEdit(role, 'draft');

  const columns: Column<InwardPlanSheetRow>[] = [
    { key: 'product_code', label: 'Product', kind: 'mono', filter: 'text', source: 'form', accessor: (r) => r.product_code,
      info: 'The product code on the sheet — one style across all its colours and sizes.' },
    { key: 'category', label: 'Category', kind: 'text', filter: 'select', source: 'easyecom', accessor: (r) => r.category ?? '—',
      info: 'The product category from the product master.' },
    { key: 'po_no', label: 'PO ref', kind: 'mono', filter: 'text', source: 'form', accessor: (r) => r.po_no ?? '—',
      info: 'The purchase order the team expects to inward from this month, as written on the sheet.' },
    { key: 'po_type', label: 'PO type', kind: 'text', filter: 'select', source: 'computed', accessor: (r) => r.po_type ?? '—',
      info: 'JOB, FOB or EFOB — read off the PO reference (FY26-27/EFOB/…).' },
    { key: 'vendor_name', label: 'Vendor', kind: 'text', filter: 'select', source: 'form', accessor: (r) => r.vendor_name ?? '—',
      info: 'The vendor code on the sheet.' },
    { key: 'inward_qty', label: 'Planned qty', kind: 'num', source: 'form', accessor: (r) => r.inward_qty ?? 0, render: (r) => (r.inward_qty == null ? '—' : fmt.format(r.inward_qty)),
      info: 'WHAT: pieces the team plans to inward from this PO in the month.\n\nHOW: the "Inward qty this month" column of the sheet.' },
    { key: 'cost_per_piece', label: 'Cost / pc', kind: 'num', source: 'form', accessor: (r) => r.cost_per_piece ?? 0, render: (r) => (r.cost_per_piece == null ? '—' : fmt.format(r.cost_per_piece)),
      info: 'The per-piece cost written on the sheet.' },
    { key: 'value', label: 'Value', kind: 'num', source: 'computed', accessor: (r) => r.value, render: (r) => money.format(r.value),
      info: 'WHAT: the money the planned inward represents.\n\nHOW: planned qty × cost per piece.' },
    { key: 'received_in_month', label: 'Received (month)', kind: 'num', source: 'easyecom', accessor: (r) => r.received_in_month, render: (r) => fmt.format(r.received_in_month),
      info: 'WHAT: what has actually landed against this PO inside the plan month.\n\nHOW: goods-receipt (GRN) pieces for the PO reference dated in the month.' },
    { key: 'variance', label: 'Variance', kind: 'num', source: 'computed', accessor: (r) => r.variance ?? 0,
      render: (r) => r.variance == null ? '—' : <span className={r.variance < 0 ? 'wf-over-tag' : ''}>{r.variance > 0 ? '+' : ''}{fmt.format(r.variance)}</span>,
      info: 'WHAT: how far the month is from the plan on this PO.\n\nHOW: received (month) − planned qty. Negative = still to come (or short).' },
    { key: 'received_total', label: 'Received (all time)', kind: 'num', source: 'easyecom', accessor: (r) => r.received_total, render: (r) => fmt.format(r.received_total),
      info: 'GRN pieces for the PO reference on any date — the PO may have started arriving in an earlier month.' },
    { key: 'last_received_on', label: 'Last GRN', kind: 'text', source: 'easyecom', accessor: (r) => r.last_received_on ?? '', render: (r) => dateLabel(r.last_received_on),
      info: 'The date of the latest goods receipt on this PO.' },
    { key: 'approval_status', label: 'Status', kind: 'text', filter: 'select', source: 'supabase', accessor: (r) => r.approval_status, render: (r) => <StatusPill status={r.approval_status} approverEdited={r.approver_edited} />,
      info: 'Approval Pending (waiting for the admin), Approved (Edited & Approved or First time Approved), Rework / Reassign or Rejected / Discarded — a remark is mandatory for the last two. The month is decided in one go on Approvals; a single line can be decided here by an admin.' },
    { key: 'mt_comments', label: 'Management comment', kind: 'text', source: 'supabase', accessor: (r) => r.mt_comments ?? '', render: (r) => r.mt_comments ?? '—',
      info: 'The note recorded with the approval, rework or rejection.' },
    { key: 'remarks', label: 'Team remark', kind: 'text', source: 'form', accessor: (r) => r.remarks ?? '', render: (r) => r.remarks ?? '—',
      info: 'The remark the team wrote on the sheet, if any.' },
    { key: 'updated_by', label: 'Last change', kind: 'text', source: 'supabase', accessor: (r) => r.updated_at, render: (r) => <span className="wf-subtle">{dateLabel(r.updated_at)}</span>,
      info: 'When the line was last loaded or decided.' },
  ];
  if (approver || editor) {
    columns.push({
      key: 'actions', label: 'Action', kind: 'text', filter: 'none', sortable: false, source: 'supabase',
      render: (r) => <RowActions row={r} approver={approver} editor={editor} inRow />,
    });
  }

  return (
    <>
      <Notice tone="info">
        The team&rsquo;s monthly inward sheet — one line per PO and product the team intends to inward in the month,
        with the cost written on the sheet. A loaded month waits as <strong>Approval Pending</strong> until an admin decides it
        (on <strong>Approvals → Inward Plan (month)</strong>, or line by line here: Approve, Edit &amp; approve, Rework / Reassign or
        Reject / Discard — a remark is mandatory for the last two). <strong>Received (month)</strong> is
        what has actually landed against each PO inside the month, from goods receipts.
      </Notice>

      <div className="wf-toolbar" style={{ alignItems: 'flex-end', gap: 16 }}>
        <label className="wf-field">
          <span>Plan month</span>
          <select value={month} onChange={(e) => { setMonth(e.target.value); setStatusFilter('all'); }}>
            {monthOptions.map((m) => {
              const n = rows.filter((r) => r.plan_month === m).length;
              return <option key={m} value={m}>{monthLabel(m)}{n ? ` · ${n} lines` : ' · empty'}</option>;
            })}
          </select>
        </label>
        <div className="segment wf-segment">
          <button type="button" className={statusFilter === 'all' ? 'active' : ''} onClick={() => setStatusFilter('all')}>All ({monthRows.length})</button>
          {STATUSES.map((s) => (
            <button type="button" key={s} className={statusFilter === s ? 'active' : ''} onClick={() => setStatusFilter(s)}>{s === 'Approved' ? 'Approved' : sheetStatusText(s)} ({totals.by[s] ?? 0})</button>
          ))}
        </div>
        {editor && <ImportSheet month={month} monthOptions={monthOptions} />}
      </div>

      <div className="iw-tiles">
        <div className="iw-tile">
          <span>Planned <InfoDot text="WHAT: what the sheet says will come in this month.

HOW: Σ planned qty over every line of the month, whatever its status." /></span>
          <strong>{fmt.format(totals.qty)} pcs</strong>
          <small>{totals.lines} line(s)</small>
        </div>
        <div className="iw-tile">
          <span>Value <InfoDot text="WHAT: the money the planned inward represents.

HOW: Σ planned qty × cost per piece over every line of the month." /></span>
          <strong>{money.format(totals.value)}</strong>
          <small>{fmt.format(totals.approvedQty)} pcs approved · {money.format(totals.approvedValue)}</small>
        </div>
        <div className="iw-tile">
          <span>Received <InfoDot text="WHAT: what has actually landed against the month's POs.

HOW: Σ GRN pieces for each PO reference dated inside the plan month, over every line." /></span>
          <strong>{fmt.format(totals.received)} pcs</strong>
          <small>{totals.qty ? (totals.received > totals.qty ? `over plan by ${fmt.format(totals.received - totals.qty)}` : `${Math.round((totals.received / totals.qty) * 100)}% of planned`) : '—'}</small>
        </div>
        <div className="iw-tile">
          <span>Still to come <InfoDot text="WHAT: planned pieces not received yet.

HOW: planned − received, never below zero." /></span>
          <strong>{fmt.format(Math.max(0, totals.qty - totals.received))} pcs</strong>
          <small>across {totals.lines} line(s)</small>
        </div>
        <div className={`iw-tile${pendingCount ? ' is-warn' : ''}`}>
          <span>Waiting for approval <InfoDot text="WHAT: lines the admin has not decided yet.

HOW: count of lines with status Pending. The whole month can be decided at once below or on Approvals." /></span>
          <strong>{pendingCount}</strong>
          <small>{pendingCount ? 'line(s) pending · admin decides' : 'nothing pending'}</small>
        </div>
      </div>

      {approver && pendingCount > 0 && (
        <section className="wf-queue-card wf-queue-card-wide" style={{ marginBottom: 16 }}>
          <div className="wf-queue-head">
            <div>
              <h3>Decide {monthLabel(month)} — {pendingCount} pending line(s)</h3>
              <p className="wf-subtle">Approve, send back or reject every pending line of the month at once. Your note is kept on each line as the management comment.</p>
            </div>
          </div>
          <ApprovalBar
            entityType="inward_plan"
            entityId={month}
            entityLabel={`Inward plan — ${monthLabel(month)}`}
            onDone={(result) => { if (result.ok) reloadWithToast(result.message ?? 'Saved.'); }}
          />
        </section>
      )}

      {monthRows.length > 0 && (
        <div className="segment iw-boardseg" role="group" aria-label="Show the month as">
          {([['weeks', 'Weeks'], ['vendors', 'Vendors'], ['lines', 'Lines']] as const).map(([k, label]) => (
            <button key={k} type="button" className={board === k ? 'active' : ''} aria-pressed={board === k} onClick={() => setBoard(k)}>{label}</button>
          ))}
        </div>
      )}

      {monthRows.length > 0 && board === 'lines' && (
        <div className="ip-viewrow iw-linesbar">
          {layout !== 'list' ? (
            <input
              className="wf-search"
              placeholder="Search product, PO ref, vendor…"
              aria-label="Search lines"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : <span />}
          <div className="segment ip-layout-seg" role="group" aria-label="Layout">
            {(['list', 'cards', 'kanban'] as const).map((l) => (
              <button key={l} type="button" className={layout === l ? 'active' : ''} aria-pressed={layout === l} onClick={() => chooseLayout(l)}>
                {l === 'list' ? 'List' : l === 'cards' ? 'Cards' : 'Kanban'}
              </button>
            ))}
          </div>
        </div>
      )}

      {monthRows.length > 0 && board !== 'lines' ? (
        <InwardWeekBoard board={board} month={month} rows={monthRows} arrivals={arrivals} today={today} />
      ) : monthRows.length > 0 && layout === 'cards' ? (
        searched.length ? (
          <div className="ip-cards">
            {searched.map((r) => <SheetCard key={r.id} row={r} approver={approver} editor={editor} />)}
          </div>
        ) : (
          <div className="ip-empty wf-subtle">No lines match.</div>
        )
      ) : monthRows.length > 0 && layout === 'kanban' ? (
        <div className="ip-kanban">
          {KANBAN.map((s) => {
            const items = searchedAll.filter((r) => r.approval_status === s);
            return (
              <section key={s} className="ip-kcol" aria-label={sheetStatusText(s)}>
                <div className="ip-kcol-head">
                  <StatusPill status={s} />
                  <span className="ip-kcol-n">{items.length}</span>
                </div>
                {items.map((r) => <SheetCard key={r.id} row={r} approver={approver} editor={editor} compact />)}
                {!items.length && <div className="ip-kcol-more">No lines</div>}
              </section>
            );
          })}
        </div>
      ) : (
      <FilterTable
        rows={shown}
        columns={columns}
        rowKey={(r) => String(r.id)}
        rowClass={(r) => (r.approval_status === 'Rejected' ? 'wf-row-muted' : undefined)}
        searchPlaceholder="Product, PO ref, vendor…"
        emptyText={monthRows.length ? 'No lines with that status.' : `Nothing loaded for ${monthLabel(month)} yet${editor ? ' — load the sheet CSV above.' : '.'}`}
        unit="lines"
        defaultSource="form"
        download={{ filename: `inward-plan-${month.slice(0, 7)}.csv` }}
      />
      )}
    </>
  );
}

/** One line as a card (Cards / Kanban), with the same actions as the list row. */
function SheetCard({ row: r, approver, editor, compact = false }: { row: InwardPlanSheetRow; approver: boolean; editor: boolean; compact?: boolean }) {
  const planned = r.inward_qty ?? 0;
  const pct = planned > 0 ? Math.min(100, Math.round((r.received_in_month / planned) * 100)) : 0;
  return (
    <article className={`ip-card${r.approval_status === 'Rejected' ? ' wf-row-muted' : ''}`}>
      <div className="ip-card-top">
        <span className="ip-card-po mono">{r.po_no ?? '—'}</span>
        {!compact && <StatusPill status={r.approval_status} approverEdited={r.approver_edited} />}
      </div>
      <div className="ip-card-name">{r.product_code}</div>
      <div className="ip-card-meta">{[r.category, r.vendor_name, r.po_type].filter(Boolean).join(' · ') || '—'}</div>
      <div className="ip-card-figs">
        <span><small>Planned</small>{r.inward_qty == null ? '—' : fmt.format(r.inward_qty)}</span>
        <span><small>₹ / pc</small>{r.cost_per_piece == null ? '—' : fmt.format(r.cost_per_piece)}</span>
        <span><small>Value</small>{money.format(r.value)}</span>
      </div>
      <span className="ip-card-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
      <div className="ip-card-foot">
        <span className="ip-card-when">
          Received {fmt.format(r.received_in_month)} this month
          {planned > 0 && r.received_in_month > planned ? ` · over plan by ${fmt.format(r.received_in_month - planned)}` : planned > 0 ? ` · ${pct}%` : ''}
        </span>
        <span className="ip-card-status">Last GRN {dateLabel(r.last_received_on)}</span>
      </div>
      {r.mt_comments && <div className="ip-card-meta">Management: {r.mt_comments}</div>}
      {r.remarks && <div className="ip-card-meta">Team: {r.remarks}</div>}
      {(approver || editor) && <RowActions row={r} approver={approver} editor={editor} />}
    </article>
  );
}

/** Per-line decision (admin) and removal (team / admin) — the odd PO handled on its own. */
function RowActions({ row, approver, editor, inRow = false }: { row: InwardPlanSheetRow; approver: boolean; editor: boolean; inRow?: boolean }) {
  const cls = `wf-inline-actions${inRow ? ' iw-row-actions' : ''}`;
  const [pending, start] = useTransition();
  const [mode, setMode] = useState<'' | 'RE-WORK' | 'Rejected' | 'EDIT'>('');
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(row.inward_qty?.toString() ?? '');
  const [cost, setCost] = useState(row.cost_per_piece?.toString() ?? '');

  function editApprove() {
    const fd = new FormData();
    fd.set('id', String(row.id));
    fd.set('inward_qty', qty);
    fd.set('cost_per_piece', cost);
    fd.set('notes', note);
    start(async () => {
      const res = await editAndApproveInwardRow(fd);
      if (!res.ok) toastError(res.error);
      else reloadWithToast(res.message ?? 'Edited & Approved.');
    });
  }

  function decide(status: string, notes: string) {
    const fd = new FormData();
    fd.set('id', String(row.id));
    fd.set('status', status);
    fd.set('notes', notes);
    start(async () => {
      const res = await decideInwardPlanRow(fd);
      if (!res.ok) toastError(res.error);
      else reloadWithToast(res.message ?? 'Saved.');
    });
  }
  async function remove() {
    const ok = await confirmDelete({
      title: 'Delete this inward plan line?',
      body: 'The line is removed from the month\'s inward plan. This cannot be undone from the screen.',
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set('id', String(row.id));
    start(async () => {
      const res = await deleteInwardPlanRow(fd);
      if (!res.ok) toastError(res.error);
      else reloadWithToast(res.message ?? 'Removed.');
    });
  }

  if (mode === 'EDIT') {
    return (
      <span className={cls}>
        <input type="number" min={0} style={{ width: 80 }} aria-label="Inward qty" title="Inward qty" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input type="number" min={0} step="0.01" style={{ width: 80 }} aria-label="₹ per piece" title="₹ per piece" value={cost} onChange={(e) => setCost(e.target.value)} />
        <input style={{ width: 140 }} placeholder="Comment (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending} onClick={editApprove}>{pending ? 'Saving…' : 'Save & approve'}</button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setMode(''); setNote(''); }}>Cancel</button>
      </span>
    );
  }
  if (mode) {
    return (
      <span className={cls}>
        <input
         
          style={{ width: 160 }}
          placeholder={mode === 'Rejected' ? 'Remark for Reject / Discard (required)' : 'Remark for Rework / Reassign (required)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !note.trim()} onClick={() => decide(mode, note)}>Save</button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setMode(''); setNote(''); }}>Cancel</button>
      </span>
    );
  }
  return (
    <span className={cls}>
      {approver && row.approval_status !== 'Approved' && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => decide('Approved', '')}>Approve</button>
      )}
      {approver && row.approval_status !== 'Approved' && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} title="Change the qty or ₹ per piece and approve in one step" onClick={() => setMode('EDIT')}>Edit &amp; approve</button>
      )}
      {approver && row.approval_status !== 'RE-WORK' && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => setMode('RE-WORK')}>Rework / Reassign</button>
      )}
      {approver && row.approval_status !== 'Rejected' && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => setMode('Rejected')}>Reject / Discard</button>
      )}
      {approver && row.approval_status !== 'Pending' && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={() => decide('Pending', '')}>Reopen</button>
      )}
      {editor && (row.approval_status === 'Pending' || approver) && (
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" title="Remove this line" disabled={pending} onClick={remove}>
          <Trash2 size={13} />
        </button>
      )}
    </span>
  );
}

/** Load a month from the sheet's CSV export (the same file the team already keeps). */
function ImportSheet({ month, monthOptions }: { month: string; monthOptions: string[] }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(month);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  function submit() {
    if (!file) return;
    start(async () => {
      const text = await file.text();
      const fd = new FormData();
      fd.set('plan_month', target);
      fd.set('csv', text);
      const res = await importInwardPlanSheet(fd);
      if (!res.ok) { setResult(res.error); toastError(res.error); return; }
      setResult(res.message ?? 'Loaded.');
      reloadWithToast(res.message ?? 'Loaded.');
    });
  }

  if (!open) {
    return (
      <button type="button" className="wf-btn wf-btn-primary" onClick={() => { setTarget(month); setOpen(true); }}>
        <Upload size={15} /> Load month from CSV
      </button>
    );
  }
  return (
    <div className="wf-queue-card" style={{ padding: 12, minWidth: 320 }}>
      <p className="wf-subtle" style={{ marginTop: 0 }}>
        Export the team&rsquo;s <strong>INWARD PLAN</strong> sheet as CSV (columns: PRODUCT CODE, PO NO., Vendor name,
        Inward qty this month, Cost/Piece). Pending lines of the month are replaced; decided lines are kept.
      </p>
      <div className="wf-inline-actions" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          {monthOptions.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
        <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending || !file} onClick={submit}>
          {pending ? 'Loading…' : 'Load for approval'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setOpen(false); setResult(null); }}>Close</button>
      </div>
      {result && <p className="wf-inline-error" style={{ marginBottom: 0 }}>{result}</p>}
    </div>
  );
}
