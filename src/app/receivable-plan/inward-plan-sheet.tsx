'use client';

import { confirmDelete } from '@/lib/confirm';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Check, Pencil, RotateCcw, Upload, Trash2, X } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { Notice } from '@/components/forms/form-layout';
import { canApprove, canEdit, sheetStatusText } from '@/lib/forms/approval';
import {
  addInwardPlanRow,
  decideInwardPlanRow,
  decideInwardPlanRows,
  deleteInwardPlanRow,
  deleteInwardPlanRows,
  editAndApproveInwardRow,
  importInwardPlanSheet,
  updateInwardPlanRow,
} from '@/lib/forms/actions';
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
  const [layout, setLayout] = useState<'list' | 'cards' | 'kanban'>('kanban');
  const [query, setQuery] = useState('');
  // Lines ticked for a bulk action (ids), and the rows the list currently shows (for "select all shown").
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [listRows, setListRows] = useState<InwardPlanSheetRow[]>([]);
  const toggle = (id: number) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectMany = (ids: number[], on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  useEffect(() => {
    try {
      const saved = localStorage.getItem('ip-sheet-layout-v2');
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from storage on mount
      if (saved === 'list' || saved === 'cards' || saved === 'kanban') setLayout(saved);
    } catch {
      /* storage blocked: keep kanban */
    }
  }, []);
  const chooseLayout = (l: 'list' | 'cards' | 'kanban') => {
    setLayout(l);
    try { localStorage.setItem('ip-sheet-layout-v2', l); } catch { /* ignore */ }
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

  const canBulk = approver || editor;
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
  if (canBulk) {
    columns.unshift({
      key: 'pick', label: '', kind: 'text', filter: 'none', sortable: false, source: 'supabase',
      render: (r) => (
        <input type="checkbox" aria-label={`Select ${r.product_code} ${r.po_no ?? ''}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
      ),
    });
  }
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
          <select value={month} onChange={(e) => { setMonth(e.target.value); setStatusFilter('all'); setSelected(new Set()); }}>
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

HOW: count of lines with status Pending. Decide them line by line in Lines (tick several to decide them together), or the whole month on Approvals." /></span>
          <strong>{pendingCount}</strong>
          <small>{pendingCount ? 'line(s) pending · admin decides' : 'nothing pending'}</small>
        </div>
      </div>

      {monthRows.length > 0 && (
        <div className="segment iw-boardseg" role="group" aria-label="Show the month as">
          {([['weeks', 'Weeks'], ['vendors', 'Vendors'], ['lines', 'Lines']] as const).map(([k, label]) => (
            <button key={k} type="button" className={board === k ? 'active' : ''} aria-pressed={board === k} onClick={() => setBoard(k)}>{label}</button>
          ))}
        </div>
      )}

      {monthRows.length > 0 && board === 'lines' && (
        <div className="ip-viewrow iw-linesbar">
          <div className="iw-linesbar-left">
            {layout !== 'list' && (
              <input
                className="wf-search"
                placeholder="Search product, PO ref, vendor…"
                aria-label="Search lines"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            {editor && <AddLine key={month} month={month} />}
          </div>
          <div className="iw-linesbar-right">
            {canBulk && (() => {
              const visible = layout === 'list' ? listRows : layout === 'cards' ? searched : searchedAll;
              const all = visible.length > 0 && visible.every((r) => selected.has(r.id));
              return visible.length > 0 ? (
                <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => (all ? setSelected(new Set()) : selectMany(visible.map((r) => r.id), true))}>
                  {all ? 'Clear selection' : `Select all shown (${visible.length})`}
                </button>
              ) : null;
            })()}
          <div className="segment ip-layout-seg" role="group" aria-label="Layout">
            {(['kanban', 'cards', 'list'] as const).map((l) => (
              <button key={l} type="button" className={layout === l ? 'active' : ''} aria-pressed={layout === l} onClick={() => chooseLayout(l)}>
                {l === 'list' ? 'List' : l === 'cards' ? 'Cards' : 'Kanban'}
              </button>
            ))}
          </div>
          </div>
        </div>
      )}

      {monthRows.length > 0 && board === 'lines' && canBulk && (
        <BulkBar
          selected={monthRows.filter((r) => selected.has(r.id))}
          approver={approver}
          editor={editor}
          onClear={() => setSelected(new Set())}
        />
      )}

      {monthRows.length > 0 && board !== 'lines' ? (
        <InwardWeekBoard board={board} month={month} rows={monthRows} arrivals={arrivals} today={today} />
      ) : monthRows.length > 0 && layout === 'cards' ? (
        searched.length ? (
          <div className="ip-cards">
            {searched.map((r) => <SheetCard key={r.id} row={r} approver={approver} editor={editor} picked={canBulk ? selected.has(r.id) : undefined} onPick={() => toggle(r.id)} />)}
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
                  {canBulk && items.length > 0 ? (
                    <label className="iw-colpick">
                      <input
                        type="checkbox"
                        aria-label={`Select every ${sheetStatusText(s)} line`}
                        checked={items.every((r) => selected.has(r.id))}
                        onChange={(e) => selectMany(items.map((r) => r.id), e.target.checked)}
                      />
                      <StatusPill status={s} />
                    </label>
                  ) : <StatusPill status={s} />}
                  <span className="ip-kcol-n">{items.length}</span>
                </div>
                {items.map((r) => <SheetCard key={r.id} row={r} approver={approver} editor={editor} compact picked={canBulk ? selected.has(r.id) : undefined} onPick={() => toggle(r.id)} />)}
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
        rowClass={(r) => [r.approval_status === 'Rejected' ? 'wf-row-muted' : '', selected.has(r.id) ? 'iw-picked' : ''].filter(Boolean).join(' ') || undefined}
        onVisibleRows={setListRows}
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
function SheetCard({
  row: r,
  approver,
  editor,
  compact = false,
  picked,
  onPick,
}: {
  row: InwardPlanSheetRow;
  approver: boolean;
  editor: boolean;
  compact?: boolean;
  /** Ticked for a bulk action; undefined = no checkbox (nothing the viewer can do in bulk). */
  picked?: boolean;
  onPick?: () => void;
}) {
  const planned = r.inward_qty ?? 0;
  const pct = planned > 0 ? Math.min(100, Math.round((r.received_in_month / planned) * 100)) : 0;
  return (
    <article className={`ip-card${r.approval_status === 'Rejected' ? ' wf-row-muted' : ''}${picked ? ' iw-picked' : ''}`}>
      <div className="ip-card-top">
        {picked !== undefined ? (
          <label className="iw-cardpick">
            <input type="checkbox" checked={picked} onChange={onPick} aria-label={`Select ${r.product_code} ${r.po_no ?? ''}`} />
            <span className="ip-card-po mono">{r.po_no ?? '—'}</span>
          </label>
        ) : (
          <span className="ip-card-po mono">{r.po_no ?? '—'}</span>
        )}
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

/**
 * Decide or remove the ticked lines at once — the Buying Plan bulk bar: floats at the bottom of
 * the screen while lines are ticked. The approver approves, reworks, rejects (one remark, recorded
 * on each line) or reopens; team or admin deletes (the team only still-pending lines).
 */
function BulkBar({
  selected,
  approver,
  editor,
  onClear,
}: {
  selected: InwardPlanSheetRow[];
  approver: boolean;
  editor: boolean;
  onClear: () => void;
}) {
  const [asking, setAsking] = useState<null | 'RE-WORK' | 'Rejected'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const n = selected.length;
  if (!n) return null;
  const ids = JSON.stringify(selected.map((r) => r.id));
  const qty = selected.reduce((s, r) => s + (r.inward_qty ?? 0), 0);
  const value = selected.reduce((s, r) => s + r.value, 0);

  function decide(status: string) {
    setError(null);
    if ((status === 'RE-WORK' || status === 'Rejected') && !note.trim()) {
      setError('A remark is mandatory — it is recorded on each line.');
      return;
    }
    const fd = new FormData();
    fd.set('ids', ids);
    fd.set('status', status);
    fd.set('notes', status === 'RE-WORK' || status === 'Rejected' ? note.trim() : '');
    start(async () => {
      const res = await decideInwardPlanRows(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Saved.');
      else setError(toastError(res.error));
    });
  }
  async function remove() {
    const ok = await confirmDelete({
      title: `Delete ${n} inward plan line${n === 1 ? '' : 's'}?`,
      body: approver
        ? 'The ticked lines are removed from the month\'s inward plan. This cannot be undone from the screen.'
        : 'The ticked lines are removed from the month\'s inward plan; approved lines are locked and kept. This cannot be undone from the screen.',
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set('ids', ids);
    start(async () => {
      const res = await deleteInwardPlanRows(fd);
      if (res.ok) reloadWithToast(res.message ?? 'Removed.');
      else setError(toastError(res.error));
    });
  }

  return (
    <div className="bp-bulk-bar" role="region" aria-label="Act on the ticked lines">
      <span className="bp-bulk-count">
        <b>{n}</b> line{n === 1 ? '' : 's'} ticked · {fmt.format(qty)} pcs · {money.format(value)}
      </span>
      {asking ? (
        <>
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={asking === 'RE-WORK' ? 'Remark for Rework / Reassign (required) — recorded on each line' : 'Remark for Reject / Discard (required) — recorded on each line'}
            aria-label={`Reason to ${asking === 'RE-WORK' ? 'rework' : 'reject'} the ticked lines`}
            onKeyDown={(e) => {
              if (e.key === 'Enter') decide(asking);
              if (e.key === 'Escape') setAsking(null);
            }}
          />
          <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => decide(asking)}>
            {pending ? 'Saving…' : asking === 'RE-WORK' ? `Rework / Reassign ${n}` : `Reject / Discard ${n}`}
          </button>
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => { setAsking(null); setError(null); }}>
            Cancel
          </button>
        </>
      ) : (
        <>
          {approver && (
            <>
              <button type="button" className="bp-bulk-btn strong" disabled={pending} onClick={() => decide('Approved')}>
                <Check size={13} /> {pending ? 'Saving…' : `Approve ${n}`}
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setAsking('RE-WORK')}>
                <RotateCcw size={13} /> Rework / Reassign
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => setAsking('Rejected')}>
                <X size={13} /> Reject / Discard
              </button>
              <button type="button" className="bp-bulk-btn" disabled={pending} onClick={() => decide('Pending')}>
                Reopen
              </button>
            </>
          )}
          {editor && (
            <button type="button" className="bp-bulk-btn" disabled={pending} onClick={remove}>
              <Trash2 size={13} /> Delete
            </button>
          )}
          <button type="button" className="bp-bulk-btn" disabled={pending} onClick={onClear}>
            Clear
          </button>
        </>
      )}
      {error && <span className="bp-bulk-error">{error}</span>}
    </div>
  );
}

/**
 * One line's decision — the Buying Plan line decision: ✓ Approve, ✎ Edit & approve, ↺ Rework,
 * ✕ Reject, the remark asked inline (Enter saves, Esc cancels). A decided line shows its status
 * with Reopen; the team can remove a still-pending line.
 */
function RowActions({ row, approver, editor }: { row: InwardPlanSheetRow; approver: boolean; editor: boolean; inRow?: boolean }) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState<null | 'RE-WORK' | 'Rejected' | 'EDIT' | 'AMEND'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(row.inward_qty?.toString() ?? '');
  const [cost, setCost] = useState(row.cost_per_piece?.toString() ?? '');
  const label = `${row.product_code} · ${row.po_no ?? '—'}`;
  const decided = row.approval_status === 'Approved' || row.approval_status === 'Rejected';

  function finish(res: { ok: boolean; message?: string; error?: string }) {
    if (res.ok) reloadWithToast(res.message ?? 'Saved.');
    else setError(toastError(res.error ?? 'Could not save.'));
  }
  function decide(status: string) {
    setError(null);
    if ((status === 'RE-WORK' || status === 'Rejected') && !note.trim()) {
      setError('A remark is mandatory.');
      return;
    }
    const fd = new FormData();
    fd.set('id', String(row.id));
    fd.set('status', status);
    fd.set('notes', status === 'RE-WORK' || status === 'Rejected' ? note.trim() : '');
    start(async () => finish(await decideInwardPlanRow(fd)));
  }
  function editApprove() {
    setError(null);
    const fd = new FormData();
    fd.set('id', String(row.id));
    fd.set('inward_qty', qty);
    fd.set('cost_per_piece', cost);
    fd.set('notes', note.trim());
    start(async () => finish(await editAndApproveInwardRow(fd)));
  }
  async function remove() {
    const ok = await confirmDelete({
      title: 'Delete this inward plan line?',
      body: 'The line is removed from the month\'s inward plan. This cannot be undone from the screen.',
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set('id', String(row.id));
    start(async () => finish(await deleteInwardPlanRow(fd)));
  }
  const cancel = () => { setAsking(null); setNote(''); setError(null); };

  // House rule: until a line is approved, the team can change every field of it.
  if (asking === 'AMEND') {
    return (
      <span className="bp-line-decision asking iw-amend">
        <LineForm
          row={row}
          pending={pending}
          submitLabel={row.approval_status === 'Pending' ? 'Save' : 'Save & resubmit'}
          onCancel={cancel}
          onSubmit={(fd) => {
            setError(null);
            fd.set('id', String(row.id));
            start(async () => finish(await updateInwardPlanRow(fd)));
          }}
        />
        {error && <span className="bp-line-decision-error">{error}</span>}
      </span>
    );
  }
  if (asking === 'EDIT') {
    return (
      <span className="bp-line-decision asking">
        <input type="number" min={0} className="iw-ld-num" aria-label={`Inward qty for ${label}`} title="Inward qty" value={qty} onChange={(e) => setQty(e.target.value)} />
        <input type="number" min={0} step="0.01" className="iw-ld-num" aria-label={`₹ per piece for ${label}`} title="₹ per piece" value={cost} onChange={(e) => setCost(e.target.value)} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Comment (optional)" aria-label={`Comment for ${label}`} onKeyDown={(e) => { if (e.key === 'Escape') cancel(); }} />
        <button type="button" className="wf-btn wf-btn-sm wf-btn-primary" disabled={pending} onClick={editApprove}>{pending ? '…' : 'Edit & approve'}</button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={cancel}>Cancel</button>
        {error && <span className="bp-line-decision-error">{error}</span>}
      </span>
    );
  }
  if (asking) {
    return (
      <span className="bp-line-decision asking">
        <input
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={asking === 'RE-WORK' ? 'Remark for Rework / Reassign (required)' : 'Remark for Reject / Discard (required)'}
          aria-label={`Reason to ${asking === 'RE-WORK' ? 'rework' : 'reject'} ${label}`}
          onKeyDown={(e) => {
            if (e.key === 'Enter') decide(asking);
            if (e.key === 'Escape') cancel();
          }}
        />
        <button type="button" className={`wf-btn wf-btn-sm ${asking === 'Rejected' ? 'wf-btn-danger' : 'wf-btn-primary'}`} disabled={pending} onClick={() => decide(asking)}>
          {pending ? '…' : asking === 'RE-WORK' ? 'Rework / Reassign' : 'Reject / Discard'}
        </button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={cancel}>Cancel</button>
        {error && <span className="bp-line-decision-error">{error}</span>}
      </span>
    );
  }

  const canRemove = editor && (row.approval_status !== 'Approved' || approver);
  const canAmend = editor && row.approval_status !== 'Approved';
  return (
    <span className="bp-line-decision">
      {canAmend && (
        <button type="button" className="bp-ld-btn" disabled={pending} onClick={() => setAsking('AMEND')} title={`Change any field of ${label}`} aria-label={`Edit ${label}`}>
          Edit
        </button>
      )}
      {approver && decided && (
        <>
          <span className={`bp-badge ${row.approval_status === 'Approved' ? 'green' : 'red'}`}>
            {sheetStatusText(row.approval_status, { approverEdited: row.approver_edited })}
          </span>
          <button type="button" className="bp-ld-btn" disabled={pending} onClick={() => decide('Pending')} title={`Reopen ${label}`}>Reopen</button>
        </>
      )}
      {approver && !decided && (
        <>
          <button type="button" className="bp-ld-btn approve" disabled={pending} onClick={() => decide('Approved')} title={`Approve ${label}`} aria-label={`Approve ${label}`}>
            <Check size={13} /> Approve
          </button>
          <button type="button" className="bp-ld-btn" disabled={pending} onClick={() => setAsking('EDIT')} title={`Change the qty or ₹ per piece of ${label} and approve it`} aria-label={`Edit and approve ${label}`}>
            <Pencil size={13} />
          </button>
          {row.approval_status !== 'RE-WORK' && (
            <button type="button" className="bp-ld-btn" disabled={pending} onClick={() => setAsking('RE-WORK')} title={`Rework / Reassign ${label}`} aria-label={`Rework / Reassign ${label}`}>
              <RotateCcw size={13} />
            </button>
          )}
          <button type="button" className="bp-ld-btn reject" disabled={pending} onClick={() => setAsking('Rejected')} title={`Reject / Discard ${label}`} aria-label={`Reject / Discard ${label}`}>
            <X size={13} />
          </button>
        </>
      )}
      {canRemove && (
        <button type="button" className="bp-ld-btn reject" disabled={pending} onClick={remove} title={`Remove ${label}`} aria-label={`Remove ${label}`}>
          <Trash2 size={13} />
        </button>
      )}
      {error && <span className="bp-line-decision-error">{error}</span>}
    </span>
  );
}

/** Every field of a sheet line — used to amend a line (until approved) and to add one. */
function LineForm({
  row,
  pending,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  row?: InwardPlanSheetRow;
  pending: boolean;
  submitLabel: string;
  onSubmit: (fd: FormData) => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="iw-lineform"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(new FormData(e.currentTarget));
      }}
      onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
    >
      <label>Product<input name="product_code" required defaultValue={row?.product_code ?? ''} /></label>
      <label>PO ref<input name="po_no" defaultValue={row?.po_no ?? ''} className="iw-lf-wide" /></label>
      <label>Vendor<input name="vendor_name" defaultValue={row?.vendor_name ?? ''} /></label>
      <label>Inward qty<input name="inward_qty" type="number" min={0} required defaultValue={row?.inward_qty ?? ''} className="iw-lf-num" /></label>
      <label>₹ / pc<input name="cost_per_piece" type="number" min={0} step="0.01" defaultValue={row?.cost_per_piece ?? ''} className="iw-lf-num" /></label>
      <label>Remark<input name="remarks" defaultValue={row?.remarks ?? ''} className="iw-lf-wide" /></label>
      <span className="iw-lf-actions">
        <button type="submit" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending}>{pending ? 'Saving…' : submitLabel}</button>
        <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/** Add one line to the month by hand (team / admin); it waits for approval like a CSV line. */
function AddLine({ month }: { month: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setOpen(true)}>+ Add line</button>
    );
  }
  return (
    <div className="iw-addline">
      <b>Add a line to {monthLabel(month)}</b>
      <LineForm
        pending={pending}
        submitLabel="Add line"
        onCancel={() => setOpen(false)}
        onSubmit={(fd) => {
          fd.set('plan_month', month);
          start(async () => {
            const res = await addInwardPlanRow(fd);
            if (res.ok) reloadWithToast(res.message ?? 'Added.');
            else toastError(res.error);
          });
        }}
      />
    </div>
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
