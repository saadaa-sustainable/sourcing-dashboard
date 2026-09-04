'use client';

import { useMemo } from 'react';
import { FilterTable, type Column } from '@/components/filter-table';
import { Notice } from '@/components/forms/form-layout';
import type { VendorOtifRow } from '@/lib/forms/types';

const pct = (v: number) => `${v}%`;

export function VendorOtifClient({
  windowDays,
  vendors,
}: {
  windowDays: number;
  vendors: VendorOtifRow[];
}) {
  // Overall rates across every received PO in the window (weighted by PO count).
  const totals = useMemo(() => {
    let pos = 0;
    let onTime = 0;
    let inFull = 0;
    let otif = 0;
    for (const v of vendors) {
      pos += v.pos;
      onTime += v.onTimePos;
      inFull += v.inFullPos;
      otif += v.otifPos;
    }
    const rate = (n: number) => (pos > 0 ? Math.round((n / pos) * 100) : 0);
    return { pos, onTimePct: rate(onTime), fillPct: rate(inFull), otifPct: rate(otif) };
  }, [vendors]);

  const columns: Column<VendorOtifRow>[] = [
    { key: 'vendorName', label: 'Vendor', kind: 'text', filter: 'text' },
    { key: 'pos', label: 'POs', kind: 'num', accessor: (r) => r.pos },
    {
      key: 'criticalPathPct',
      label: 'Critical Path %',
      kind: 'num',
      accessor: (r) => r.criticalPathPct ?? -1,
      render: (r) =>
        r.criticalPathPct == null ? '—' : `${pct(r.criticalPathPct)}`,
      info: 'On-track share of this vendor’s OPEN POs (TNA stages not overdue) — the third OTIF variable, from the Open PO Tracker logic. Blank if the vendor has no open POs.',
    },
    {
      key: 'onTimePct',
      label: 'On-Time %',
      kind: 'num',
      accessor: (r) => r.onTimePct,
      render: (r) => `${pct(r.onTimePct)}`,
      info: 'Share of POs delivered by the committed date. Uses the vendor commitment log where present, else the historical PO EDD.',
    },
    {
      key: 'fillPct',
      label: 'Fill %',
      kind: 'num',
      accessor: (r) => r.fillPct,
      render: (r) => `${pct(r.fillPct)}`,
      info: 'Share of POs delivered in full (received qty ≥ ordered qty), from GRN.',
    },
    {
      key: 'otifPct',
      label: 'OTIF %',
      kind: 'num',
      accessor: (r) => r.otifPct,
      render: (r) => <strong>{pct(r.otifPct)}</strong>,
      info: 'Joint pass rate — a PO counts only if it was BOTH on-time and in-full.',
    },
  ];

  return (
    <>
      <Notice tone="warn">
        On-Time and OTIF are provisional while the vendor commitment log fills up. Until POs cycle
        through with logged commitments, they fall back to the historical PO expected-delivery date
        (which runs optimistic vs. the final GRN), so on-time reads low. <strong>Fill Rate is live
        now.</strong> Window: last {windowDays} days.
      </Notice>

      <div className="metric-grid compact">
        <div className="metric-card tone-teal">
          <span className="metric-label">On-Time (all POs)</span>
          <strong>{totals.onTimePct}%</strong>
        </div>
        <div className="metric-card tone-purple">
          <span className="metric-label">In-Full (all POs)</span>
          <strong>{totals.fillPct}%</strong>
        </div>
        <div className="metric-card tone-amber">
          <span className="metric-label">OTIF (joint)</span>
          <strong>{totals.otifPct}%</strong>
        </div>
        <div className="metric-card tone-orange">
          <span className="metric-label">POs measured</span>
          <strong>{totals.pos}</strong>
        </div>
      </div>

      {vendors.length ? (
        <FilterTable
          rows={vendors}
          columns={columns}
          rowKey={(r) => r.vendorCode ?? r.vendorName}
          unit="vendors"
          searchPlaceholder="Vendor…"
          emptyText="No vendors match your filters."
          download={{ filename: 'vendor-otif.csv' }}
        />
      ) : (
        <div className="panel" style={{ padding: 28 }}>
          <div className="empty-state">
            <p>No delivered POs in the window yet — OTIF fills in as GRNs are recorded.</p>
          </div>
        </div>
      )}
    </>
  );
}
