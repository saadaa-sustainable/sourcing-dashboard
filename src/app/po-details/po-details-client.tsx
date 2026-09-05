'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import type { PoDetails } from '@/lib/forms/types';

const num = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const d = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN') : '—';

// Signed docs are sometimes a Drive URL, sometimes just a filename. Link the URLs.
function DocLink({ value, label }: { value: string | null; label: string }) {
  if (!value) return null;
  const isUrl = /^https?:\/\//i.test(value);
  return isUrl ? (
    <a href={value} target="_blank" rel="noopener noreferrer" className="wf-doc-link">
      <FileText size={12} /> {label}
    </a>
  ) : (
    <span className="wf-doc-flat" title={value}>
      <FileText size={12} /> {label}
    </span>
  );
}

type ViewFilter = 'all' | 'live' | 'unmatched';

const COLS: Column<PoDetails>[] = [
  {
    key: 'po_number', label: 'PO ref', kind: 'mono',
    render: (r) => (
      <>
        {r.po_number ?? '—'}
        {r.matched_to_live_po ? <span className="wf-tna-ok">live</span> : <span className="wf-subtle">closed / not in pipeline</span>}
      </>
    ),
  },
  { key: 'easyecom_po_no', label: 'EasyEcom', kind: 'mono', render: (r) => r.easyecom_po_no ?? '—' },
  { key: 'po_type', label: 'Type', render: (r) => r.po_type ?? '—' },
  { key: 'product_code', label: 'Product', kind: 'mono', render: (r) => r.product_code ?? '—' },
  { key: 'vendor_name', label: 'Vendor', render: (r) => r.vendor_name ?? '—' },
  { key: 'po_qty', label: 'Qty', kind: 'num', render: (r) => (r.po_qty == null ? '—' : num.format(r.po_qty)) },
  { key: 'no_of_colors', label: 'Colours', kind: 'num', render: (r) => r.no_of_colors ?? '—' },
  { key: 'date_of_po_sign', label: 'Signed', accessor: (r) => r.date_of_po_sign ?? '', render: (r) => d(r.date_of_po_sign) },
  { key: 'po_closing_date', label: 'Closing', accessor: (r) => r.po_closing_date ?? '', render: (r) => d(r.po_closing_date) },
  {
    key: 'milestones', label: 'PP / GPT / Cut / Inline', filter: 'none', sortable: false,
    render: (r) => <span className="wf-subtle">{d(r.pp_sample_due)} · {d(r.gpt_due)} · {d(r.cutting_date)} · {d(r.inline_qc_date)}</span>,
  },
  {
    key: 'docs', label: 'Signed docs', filter: 'none', sortable: false,
    render: (r) => (
      <div className="wf-doc-cell">
        <DocLink value={r.signed_po_document} label="PO" />
        <DocLink value={r.signed_po_cost_sheet} label="Cost" />
        <DocLink value={r.signed_tna} label="TNA" />
        <DocLink value={r.tna_sheet_link} label="TNA sheet" />
        <DocLink value={r.cad_folder_link} label="CAD" />
      </div>
    ),
  },
  { key: 'buying_plan_no', label: 'Buying plan', render: (r) => r.buying_plan_no ?? '—' },
  { key: 'merchandiser', label: 'Merchant', render: (r) => r.merchandiser ?? '—' },
];

export function PoDetailsClient({ rows }: { rows: PoDetails[] }) {
  const [view, setView] = useState<ViewFilter>('all');
  const matched = rows.filter((r) => r.matched_to_live_po).length;

  const viewRows = useMemo(
    () =>
      rows.filter((r) =>
        view === 'live' ? r.matched_to_live_po : view === 'unmatched' ? !r.matched_to_live_po : true,
      ),
    [rows, view],
  );

  const segment = (
    <div className="segment wf-segment">
      {(['all', 'live', 'unmatched'] as ViewFilter[]).map((v) => (
        <button key={v} type="button" className={view === v ? 'active' : ''} onClick={() => setView(v)}>
          {v === 'all' ? 'All' : v === 'live' ? 'In live pipeline' : 'Not in pipeline'}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="wf-kpi-strip">
        <div className="wf-kpi">
          <span className="wf-kpi-label">Form submissions</span>
          <strong className="wf-kpi-value">{num.format(rows.length)}</strong>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">In live pipeline</span>
          <strong className="wf-kpi-value">{num.format(matched)}</strong>
        </div>
        <div className="wf-kpi">
          <span className="wf-kpi-label">Not in live pipeline</span>
          <strong className="wf-kpi-value">{num.format(rows.length - matched)}</strong>
        </div>
        <p className="wf-kpi-note">
          Auto-fetched from the “PO Details Form” Google Sheet tab. “In live pipeline”
          means the PO ref is still an open Approved PO in the GCP/EasyEcom data.
        </p>
      </div>

      <FilterTable
        rows={viewRows}
        columns={COLS}
        rowKey={(r) => r.source_row_key}
        unit="submissions"
        searchPlaceholder="PO ref, EasyEcom no, product, vendor"
        emptyText="No submissions match."
        toolbarExtra={segment}
        download={{ filename: 'po-details' }}
      />
    </>
  );
}
