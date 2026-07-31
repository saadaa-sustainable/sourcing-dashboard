'use client';

import { useMemo, useState } from 'react';
import { FileText } from 'lucide-react';
import { Field } from '@/components/forms/form-layout';
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

export function PoDetailsClient({ rows }: { rows: PoDetails[] }) {
  const [search, setSearch] = useState('');
  const [view, setView] = useState<ViewFilter>('all');

  const matched = rows.filter((r) => r.matched_to_live_po).length;

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows
      .filter((r) =>
        view === 'live'
          ? r.matched_to_live_po
          : view === 'unmatched'
            ? !r.matched_to_live_po
            : true,
      )
      .filter((r) =>
        q
          ? `${r.po_number ?? ''} ${r.easyecom_po_no ?? ''} ${r.product_code ?? ''} ${r.vendor_name ?? ''}`
              .toLowerCase()
              .includes(q)
          : true,
      );
  }, [rows, search, view]);

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

      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Search">
            <input
              value={search}
              placeholder="PO ref, EasyEcom no, product, vendor"
              onChange={(e) => setSearch(e.target.value)}
            />
          </Field>
          <div className="segment wf-segment">
            {(['all', 'live', 'unmatched'] as ViewFilter[]).map((v) => (
              <button
                key={v}
                type="button"
                className={view === v ? 'active' : ''}
                onClick={() => setView(v)}
              >
                {v === 'all' ? 'All' : v === 'live' ? 'In live pipeline' : 'Not in pipeline'}
              </button>
            ))}
          </div>
        </div>
        <div className="wf-toolbar-right">
          <span className="wf-subtle">{shown.length} shown</span>
        </div>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>PO ref</th>
                <th>EasyEcom</th>
                <th>Type</th>
                <th>Product</th>
                <th>Vendor</th>
                <th className="num">Qty</th>
                <th className="num">Colours</th>
                <th>Signed</th>
                <th>Closing</th>
                <th>PP / GPT / Cut / Inline</th>
                <th>Signed docs</th>
                <th>Buying plan</th>
                <th>Merchant</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.source_row_key}>
                  <td className="mono">
                    {r.po_number ?? '—'}
                    {r.matched_to_live_po ? (
                      <span className="wf-tna-ok">live</span>
                    ) : (
                      <span className="wf-subtle">closed / not in pipeline</span>
                    )}
                  </td>
                  <td className="mono">{r.easyecom_po_no ?? '—'}</td>
                  <td>{r.po_type ?? '—'}</td>
                  <td className="mono">{r.product_code ?? '—'}</td>
                  <td>{r.vendor_name ?? '—'}</td>
                  <td className="num">{r.po_qty == null ? '—' : num.format(r.po_qty)}</td>
                  <td className="num">{r.no_of_colors ?? '—'}</td>
                  <td>{d(r.date_of_po_sign)}</td>
                  <td>{d(r.po_closing_date)}</td>
                  <td className="wf-subtle">
                    {d(r.pp_sample_due)} · {d(r.gpt_due)} · {d(r.cutting_date)} ·{' '}
                    {d(r.inline_qc_date)}
                  </td>
                  <td>
                    <div className="wf-doc-cell">
                      <DocLink value={r.signed_po_document} label="PO" />
                      <DocLink value={r.signed_po_cost_sheet} label="Cost" />
                      <DocLink value={r.signed_tna} label="TNA" />
                      <DocLink value={r.tna_sheet_link} label="TNA sheet" />
                      <DocLink value={r.cad_folder_link} label="CAD" />
                    </div>
                  </td>
                  <td>{r.buying_plan_no ?? '—'}</td>
                  <td className="wf-subtle">{r.merchandiser ?? '—'}</td>
                </tr>
              ))}
              {!shown.length && (
                <tr>
                  <td colSpan={13} className="wf-empty-cell">
                    No submissions match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
