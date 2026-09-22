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
    let dated = 0;
    let onTime = 0;
    let inFull = 0;
    let otif = 0;
    for (const v of vendors) {
      pos += v.pos;
      dated += v.datedPos;
      onTime += v.onTimePos;
      inFull += v.inFullPos;
      otif += v.otifPos;
    }
    // On-time / OTIF are judged only over POs that have a committed date; fill
    // rate over every received PO (same denominators as the per-vendor rows).
    const over = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);
    return { pos, dated, onTimePct: over(onTime, dated), fillPct: over(inFull, pos), otifPct: over(otif, dated) };
  }, [vendors]);

  const columns: Column<VendorOtifRow>[] = [
    { key: 'vendorName', label: 'Vendor', kind: 'text', filter: 'text' },
    { key: 'pos', label: 'POs', kind: 'num', source: 'computed', accessor: (r) => r.pos },
    {
      key: 'criticalPathPct',
      source: 'computed',
      label: 'Critical Path %',
      kind: 'num',
      accessor: (r) => r.criticalPathPct ?? -1,
      render: (r) =>
        r.criticalPathPct == null ? '—' : `${pct(r.criticalPathPct)}`,
      info: "WHAT: of this vendor's OPEN POs, how many are running to time right now.\n\nHOW: open POs with no critical-path TNA stage past its planned date ÷ the vendor's open POs — the same rule the Open PO Tracker uses. Blank when the vendor has nothing open.\n\nUSE: the forward-looking number: On-time and In-full say what the vendor did, this says what is about to happen.",
    },
    {
      key: 'onTimePct',
      source: 'computed',
      label: 'On-Time %',
      kind: 'num',
      accessor: (r) => r.onTimePct,
      render: (r) => `${pct(r.onTimePct)}`,
      info: "WHAT: how often the vendor delivered by the date it committed to.\n\nHOW: POs delivered on or before the committed date ÷ rated POs. The committed date comes from the vendor commitment log when one was recorded, otherwise the PO's expected delivery date. Example: 14 of 20 → 70%.\n\nUSE: the 'on time' half of OTIF.",
    },
    {
      key: 'fillPct',
      source: 'computed',
      label: 'Fill %',
      kind: 'num',
      accessor: (r) => r.fillPct,
      render: (r) => `${pct(r.fillPct)}`,
      info: "WHAT: how often the vendor delivered the whole quantity.\n\nHOW: POs where received ≥ ordered (from goods receipts) ÷ rated POs.\n\nUSE: the 'in full' half of OTIF. A vendor that ships 95% every time never scores here — that is a short-shipment habit.",
    },
    {
      key: 'otifPct',
      source: 'computed',
      label: 'OTIF %',
      kind: 'num',
      accessor: (r) => r.otifPct,
      render: (r) => <strong>{pct(r.otifPct)}</strong>,
      info: "WHAT: OTIF — On Time In Full — the share of POs that were both on time AND complete.\n\nHOW: a PO passes only if it met both tests; passes ÷ rated POs. Example: 20 POs, 14 on time, 16 in full, 11 both → OTIF 55%.\n\nUSE: the vendor scorecard number. It is always at or below both halves.",
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
          defaultSource="easyecom"
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
