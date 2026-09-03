'use client';

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { reloadWithToast } from '@/lib/toast';
import { AlertTriangle, Download, RotateCcw, Save, Search, Trash2, X } from 'lucide-react';
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
import { ProductPicker } from '@/components/forms/product-picker';
import {
  INWARD_PLAN_STATUSES,
  type InwardPlanEntry,
  type ProductCatalogItem,
  type SdRole,
} from '@/lib/forms/types';

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

// The editable fields of a row, held as strings in a per-row draft. Edit state
// lives in the PARENT (keyed by row id) so a row's unsaved edits survive being
// filtered out of view — a child component would unmount and lose them.
type Draft = {
  po_no: string;
  vendor_name: string;
  inward_qty: string;
  cost_per_piece: string;
  remarks: string;
  actual_inward_qty: string;
  mt_comments: string;
  approval_status: string;
};
const TEAM_FIELDS: (keyof Draft)[] = [
  'po_no', 'vendor_name', 'inward_qty', 'cost_per_piece', 'remarks', 'actual_inward_qty',
];
const REVIEW_FIELDS: (keyof Draft)[] = ['mt_comments', 'approval_status'];

function draftFrom(e: InwardPlanEntry): Draft {
  return {
    po_no: e.po_no ?? '',
    vendor_name: e.vendor_name ?? '',
    inward_qty: e.inward_qty?.toString() ?? '',
    cost_per_piece: e.cost_per_piece?.toString() ?? '',
    remarks: e.remarks ?? '',
    actual_inward_qty: e.actual_inward_qty?.toString() ?? '',
    mt_comments: e.mt_comments ?? '',
    approval_status: e.approval_status,
  };
}

export function InwardPlanIiClient({
  planMonth,
  entries,
  catalog,
  role,
}: {
  planMonth: string;
  entries: InwardPlanEntry[];
  catalog: ProductCatalogItem[];
  role: SdRole;
}) {
  const editable = role !== 'viewer';
  const isAdmin = role === 'admin';
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Edit buffer, keyed by row id. A row with no entry here shows its saved
  // values; the original for dirty-detection is always re-derived from `entries`
  // (which refreshes after a save), so drafts stay clean once persisted.
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const entriesById = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries]);
  const draftOf = useCallback(
    (e: InwardPlanEntry): Draft => drafts[e.id] ?? draftFrom(e),
    [drafts],
  );
  const setField = (e: InwardPlanEntry, field: keyof Draft, value: string) => {
    setDrafts((d) => ({ ...d, [e.id]: { ...(d[e.id] ?? draftFrom(e)), [field]: value } }));
  };

  const rowState = (e: InwardPlanEntry) => {
    const d = draftOf(e);
    const o = draftFrom(e);
    const teamDirty = TEAM_FIELDS.some((k) => d[k] !== o[k]);
    const reviewDirty = REVIEW_FIELDS.some((k) => d[k] !== o[k]);
    return { d, teamDirty, reviewDirty, dirty: teamDirty || reviewDirty };
  };

  const dirtyRows = useMemo(
    () => entries.filter((e) => rowState(e).dirty),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, drafts],
  );
  const hasUnsaved = dirtyRows.length > 0;

  // Navigation: free-text search + status chips + vendor dropdown, all combine (AND).
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [vendorFilter, setVendorFilter] = useState<string>('');

  const vendors = useMemo(
    () => [...new Set(entries.map((e) => (e.vendor_name ?? '').trim()).filter(Boolean))].sort(),
    [entries],
  );

  const statusCounts = useMemo(() => {
    const c: Record<string, number> = { All: entries.length };
    for (const s of INWARD_PLAN_STATUSES) c[s] = 0;
    for (const e of entries) c[e.approval_status] = (c[e.approval_status] ?? 0) + 1;
    return c;
  }, [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (statusFilter !== 'All' && e.approval_status !== statusFilter) return false;
      if (vendorFilter && (e.vendor_name ?? '').trim() !== vendorFilter) return false;
      if (
        q &&
        ![e.product_code, e.po_no, e.vendor_name, e.remarks, e.mt_comments]
          .some((v) => (v ?? '').toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [entries, search, statusFilter, vendorFilter]);

  const hasFilter = Boolean(search || vendorFilter || statusFilter !== 'All');

  const totals = useMemo(() => {
    let qty = 0, value = 0, actual = 0, variation = 0;
    for (const e of filtered) {
      const d = draftOf(e);
      const q = Number(d.inward_qty) || 0;
      qty += q;
      value += q * (Number(d.cost_per_piece) || 0);
      actual += Number(d.actual_inward_qty) || 0;
      variation += (Number(d.actual_inward_qty) || 0) - q;
    }
    return { qty, value, actual, variation };
  }, [filtered, draftOf]);

  // Guard against losing unsaved edits on tab close / hard reload.
  useEffect(() => {
    if (!hasUnsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsaved]);

  const navGuard = (e: React.MouseEvent) => {
    if (hasUnsaved && !window.confirm('You have unsaved changes. Leave without saving?')) {
      e.preventDefault();
    }
  };

  // Persist one row (team fields and/or review fields, whichever changed).
  const persistRow = async (e: InwardPlanEntry): Promise<ActionResult> => {
    const { d, teamDirty, reviewDirty } = rowState(e);
    if (teamDirty) {
      const fd = new FormData();
      fd.set('id', String(e.id));
      fd.set('plan_month', planMonth);
      fd.set('product_code', e.product_code);
      fd.set('po_no', d.po_no);
      fd.set('vendor_name', d.vendor_name);
      fd.set('inward_qty', d.inward_qty);
      fd.set('cost_per_piece', d.cost_per_piece);
      fd.set('remarks', d.remarks);
      fd.set('actual_inward_qty', d.actual_inward_qty);
      const res = await saveInwardPlanEntry(fd);
      if (!res.ok) return res;
    }
    if (reviewDirty) {
      const fd = new FormData();
      fd.set('id', String(e.id));
      fd.set('mt_comments', d.mt_comments);
      fd.set('approval_status', d.approval_status);
      const res = await reviewInwardPlanEntry(fd);
      if (!res.ok) return res;
    }
    return { ok: true };
  };

  const saveRows = (rows: InwardPlanEntry[]) => {
    if (!rows.length) return;
    setError(null);
    start(async () => {
      for (const e of rows) {
        const res = await persistRow(e);
        if (!res.ok) {
          setError(`${e.product_code}: ${res.error}`);
          return;
        }
      }
      reloadWithToast(rows.length > 1 ? `${rows.length} rows saved.` : 'Saved.');
    });
  };

  const discard = () => {
    if (window.confirm(`Discard unsaved changes on ${dirtyRows.length} row(s)?`)) {
      setDrafts({});
      setError(null);
    }
  };

  // Add / delete go straight through (a plain server action + soft refresh).
  const run = (action: (fd: FormData) => Promise<ActionResult>, fields: Record<string, string>) => {
    setError(null);
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.set(k, v));
    start(async () => {
      const res = await action(fd);
      if (res.ok) reloadWithToast();
      else setError(res.error);
    });
  };

  const exportCsv = () =>
    downloadCsv(
      `inward-plan-ii-${planMonth.slice(0, 7)}`,
      ['Product code', 'PO no.', 'Vendor', 'Inward qty', 'Cost/piece', 'Total value', 'Remarks', 'MT comments', 'Approval status', 'Actual inward qty', 'Variation'],
      filtered.map((e) => {
        const d = draftOf(e);
        const q = Number(d.inward_qty) || 0;
        return [
          e.product_code, d.po_no, d.vendor_name, q,
          Number(d.cost_per_piece) || 0, q * (Number(d.cost_per_piece) || 0),
          d.remarks, d.mt_comments, d.approval_status,
          d.actual_inward_qty === '' ? '' : Number(d.actual_inward_qty),
          d.actual_inward_qty === '' && !q ? '' : (Number(d.actual_inward_qty) || 0) - q,
        ];
      }),
    );

  return (
    <>
      <Notice tone="info">
        The monthly inward sheet: pick a <strong>product code from the product master</strong>, then
        the team fills PO, vendor, quantity, cost and remarks; management adds <strong>MT comments</strong>{' '}
        and the <strong>approval status</strong>. Total Value and Variation (actual − planned) are computed.
        Edit any cell and press <strong>Save</strong> (per row) or <strong>Save all</strong>.
      </Notice>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <a className="wf-btn wf-btn-ghost wf-btn-sm" onClick={navGuard} href={`/buying-plan?month=${addMonths(planMonth, -1)}&type=inward`}>
            ← {monthLabel(addMonths(planMonth, -1))}
          </a>
          <strong>{monthLabel(planMonth)}</strong>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" onClick={navGuard} href={`/buying-plan?month=${addMonths(planMonth, 1)}&type=inward`}>
            {monthLabel(addMonths(planMonth, 1))} →
          </a>
        </div>
        <div className="wf-toolbar-left">
          {editable && (
            <ProductPicker
              items={catalog}
              placeholder="Add a product — search code or name…"
              disabled={pending}
              onPick={(code) => run(saveInwardPlanEntry, { plan_month: planMonth, product_code: code })}
            />
          )}
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={exportCsv} disabled={!filtered.length}>
            <Download size={13} /> CSV
          </button>
        </div>
      </div>

      {/* Unsaved-changes bar — the safety net against navigating away with edits. */}
      {editable && hasUnsaved && (
        <div className="wf-unsaved-bar">
          <span className="wf-unsaved-msg">
            <AlertTriangle size={15} />
            {dirtyRows.length} unsaved change{dirtyRows.length === 1 ? '' : 's'}
          </span>
          <div className="wf-issue-row">
            <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={pending} onClick={() => saveRows(dirtyRows)}>
              <Save size={13} /> Save all
            </button>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" disabled={pending} onClick={discard}>
              <RotateCcw size={13} /> Discard
            </button>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div className="wf-toolbar">
          <div className="wf-toolbar-left">
            <label className="search-field">
              <Search size={15} />
              <input
                placeholder="Search product, PO, vendor or remarks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button type="button" className="icon-button" aria-label="Clear search" onClick={() => setSearch('')}>
                  <X size={14} />
                </button>
              )}
            </label>
            <select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)}>
              <option value="">All vendors</option>
              {vendors.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
            {hasFilter && (
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm"
                onClick={() => { setSearch(''); setVendorFilter(''); setStatusFilter('All'); }}
              >
                Clear filters
              </button>
            )}
          </div>
          <span className="wf-chip">{fmt.format(filtered.length)} of {fmt.format(entries.length)} rows</span>
        </div>
      )}

      {entries.length > 0 && (
        <div className="segment tracker-status-tabs">
          {['All', ...INWARD_PLAN_STATUSES].map((s) => (
            <button
              key={s}
              type="button"
              className={statusFilter === s ? 'active' : ''}
              onClick={() => setStatusFilter(s)}
            >
              {s} ({fmt.format(statusCounts[s] ?? 0)})
            </button>
          ))}
        </div>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>
                  Product code
                  <InfoDot text="Picked from the product master via the Add-a-product search above." label="About Product code" />
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
              {filtered.map((e) => {
                const st = rowState(e);
                return (
                  <EntryRow
                    key={e.id}
                    entry={e}
                    draft={st.d}
                    dirty={st.dirty}
                    editable={editable}
                    isAdmin={isAdmin}
                    busy={pending}
                    onField={setField}
                    onSave={() => saveRows([e])}
                    onDelete={() => run(deleteInwardPlanEntry, { id: String(e.id) })}
                  />
                );
              })}
              {!entries.length && (
                <tr>
                  <td colSpan={editable ? 12 : 11} className="wf-empty-cell">
                    No rows yet for {monthLabel(planMonth)} — add the first product above.
                  </td>
                </tr>
              )}
              {entries.length > 0 && !filtered.length && (
                <tr>
                  <td colSpan={editable ? 12 : 11} className="wf-empty-cell">
                    No rows match your search or filters.
                  </td>
                </tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr>
                  <td><strong>{hasFilter ? 'FILTERED TOTAL' : 'TOTAL'}</strong></td>
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
  draft,
  dirty,
  editable,
  isAdmin,
  busy,
  onField,
  onSave,
  onDelete,
}: {
  entry: InwardPlanEntry;
  draft: Draft;
  dirty: boolean;
  editable: boolean;
  isAdmin: boolean;
  busy: boolean;
  onField: (e: InwardPlanEntry, field: keyof Draft, value: string) => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const q = Number(draft.inward_qty) || 0;
  const totalValue = q * (Number(draft.cost_per_piece) || 0);
  const variation = (draft.actual_inward_qty === '' ? 0 : Number(draft.actual_inward_qty) || 0) - q;

  const cell = (field: keyof Draft, kind: 'text' | 'num' = 'text', width?: number) =>
    editable ? (
      <input
        type={kind === 'num' ? 'number' : 'text'}
        min={kind === 'num' ? 0 : undefined}
        value={draft[field]}
        style={width ? { width } : undefined}
        onChange={(ev) => onField(entry, field, ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === 'Enter' && dirty) onSave(); }}
      />
    ) : (
      <span>{draft[field] || '—'}</span>
    );

  return (
    <tr className={dirty ? 'wf-row-dirty' : undefined}>
      <td className="mono">{entry.product_code}</td>
      <td>{cell('po_no', 'text', 210)}</td>
      <td>{cell('vendor_name', 'text', 90)}</td>
      <td className="num">{cell('inward_qty', 'num', 80)}</td>
      <td className="num">{cell('cost_per_piece', 'num', 80)}</td>
      <td className="num">{totalValue ? money.format(totalValue) : '—'}</td>
      <td>{cell('remarks', 'text', 150)}</td>
      <td>
        {isAdmin ? (
          <input value={draft.mt_comments} style={{ width: 200 }} onChange={(ev) => onField(entry, 'mt_comments', ev.target.value)} />
        ) : (
          <span>{entry.mt_comments || '—'}</span>
        )}
      </td>
      <td>
        {isAdmin ? (
          <select value={draft.approval_status} onChange={(ev) => onField(entry, 'approval_status', ev.target.value)}>
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
      <td className="num">{cell('actual_inward_qty', 'num', 80)}</td>
      <td className="num" style={{ color: variation < 0 ? 'var(--danger-text, #c0392b)' : 'var(--success-text, #3d9e6b)' }}>
        {draft.actual_inward_qty === '' && !q ? '—' : fmt.format(variation)}
      </td>
      {editable && (
        <td>
          <div className="wf-issue-row">
            {dirty && (
              <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" disabled={busy} onClick={onSave} title="Save this row">
                <Save size={13} />
              </button>
            )}
            {confirmDelete ? (
              <>
                <button type="button" className="wf-btn wf-btn-sm wf-btn-danger" disabled={busy} onClick={onDelete} title="Confirm delete">
                  Delete?
                </button>
                <button type="button" className="icon-button" onClick={() => setConfirmDelete(false)} title="Cancel">
                  <X size={14} />
                </button>
              </>
            ) : (
              <button type="button" className="icon-button" disabled={busy} title="Remove row" onClick={() => setConfirmDelete(true)}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}
