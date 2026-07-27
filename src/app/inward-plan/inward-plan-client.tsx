'use client';

import { useMemo, useState } from 'react';
import { Notice } from '@/components/forms/form-layout';
import type { InwardPlanGroup } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const PAGE = 25;
const norm = (v: string) => v.trim().toLowerCase();

export function InwardPlanClient({ groups }: { groups: InwardPlanGroup[] }) {
  const [search, setSearch] = useState('');
  const [vendor, setVendor] = useState('');
  const [page, setPage] = useState(0);

  const vendors = useMemo(
    () => [...new Set(groups.map((g) => g.vendor_name).filter(Boolean))].sort(),
    [groups],
  );

  const rows = groups.filter(
    (g) =>
      (!vendor || g.vendor_name === vendor) &&
      (!search ||
        [g.po_number, g.product_code, g.product_variant, g.vendor_name].some((v) =>
          norm(v).includes(norm(search)),
        )),
  );

  const totalArriving = rows.reduce((s, g) => s + g.arriving_qty, 0);
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE));
  const p = Math.min(page, pageCount - 1);
  const pageRows = rows.slice(p * PAGE, p * PAGE + PAGE);

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <label className="field">
            <span>Search</span>
            <input
              placeholder="PO, product, variant or vendor"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
          </label>
          <label className="field">
            <span>Vendor</span>
            <select
              value={vendor}
              onChange={(e) => {
                setVendor(e.target.value);
                setPage(0);
              }}
            >
              <option value="">All</option>
              {vendors.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="wf-chip">
          {fmt.format(rows.length)} lines · {fmt.format(totalArriving)} pcs arriving
        </div>
      </div>

      {!groups.length && (
        <Notice tone="info">
          No open POs with stock still to arrive. (Loads once the PO backfill has
          run.)
        </Notice>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>PO</th>
                <th>Product</th>
                <th>Variant</th>
                <th>Vendor</th>
                <th className="num">Ordered</th>
                <th className="num">Arriving</th>
                <th>Expected</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((g) => (
                <tr key={`${g.po_number}-${g.product_code}-${g.product_variant}`}>
                  <td className="mono">{g.po_number}</td>
                  <td>{g.product_code}</td>
                  <td>{g.product_variant}</td>
                  <td>
                    {g.vendor_name}
                    <small>{g.vendor_code}</small>
                  </td>
                  <td className="num">{fmt.format(g.ordered_qty)}</td>
                  <td className="num strong">{fmt.format(g.arriving_qty)}</td>
                  <td>{g.expected_delivery_date ?? '—'}</td>
                </tr>
              ))}
              {!rows.length && groups.length > 0 && (
                <tr>
                  <td colSpan={7} className="wf-empty-cell">
                    No lines match your filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {pageCount > 1 && (
          <div className="pager">
            <button type="button" disabled={p <= 0} onClick={() => setPage(p - 1)}>
              Prev
            </button>
            <span>
              Page {p + 1} of {pageCount} · {fmt.format(rows.length)} lines
            </span>
            <button
              type="button"
              disabled={p >= pageCount - 1}
              onClick={() => setPage(p + 1)}
            >
              Next
            </button>
          </div>
        )}
      </div>
    </>
  );
}
