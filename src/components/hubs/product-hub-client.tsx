'use client';

import { useMemo, useState } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { InfoDot } from '@/components/info-dot';
import type { AbcClass, ProductHubData, ProductHubRow } from '@/lib/product-hub.server';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

type ClassFilter = 'All' | AbcClass;

export function Product360Client({ data }: { data: ProductHubData }) {
  const s = data.summary;
  const [filter, setFilter] = useState<ClassFilter>('All');

  const rows = useMemo(
    () => (filter === 'All' ? data.rows : data.rows.filter((r) => r.abcClass === filter)),
    [data.rows, filter],
  );

  const inStockRate =
    s.totalSkus && s.totalSkus > 0 && s.zeroStock != null
      ? Math.round(((s.totalSkus - s.zeroStock) / s.totalSkus) * 100)
      : null;

  return (
    <>
      <div className="ca-kpi-row">
        <div className="ca-kpi">
          <span className="ca-kpi-label">In-stock rate <InfoDot text={"WHAT: the share of SKUs that had stock as of the latest snapshot.\n\nHOW: SKUs with stock above zero ÷ tracked SKUs, from the nightly inventory feed. Green at 80% and above.\n\nUSE: the headline availability number. The OOS Dashboard's Summary has the same figure with the 45-day and 365-day windows beside it."} /></span>
          <strong className={inStockRate == null ? '' : inStockRate >= 80 ? 'ca-under' : 'ca-over'}>
            {inStockRate == null ? '—' : `${inStockRate}%`}
          </strong>
          <small>{s.totalSkus != null ? `${inr.format(s.totalSkus)} SKUs · ${inr.format(s.zeroStock ?? 0)} zero-stock` : 'no OOS data'}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Stockout gaps <InfoDot text={"WHAT: fast-selling colours with nothing in stock and nothing on order.\n\nHOW: variants with zero stock AND no open PO, split by sales class (A fastest … D slowest; thresholds in Rules Master).\n\nUSE: genuinely uncovered demand — every day is lost sales. A-class first."} /></span>
          <strong className={s.stockoutGaps > 0 ? 'ca-over' : 'ca-under'}>{inr.format(s.stockoutGaps)}</strong>
          <small>no stock &amp; no open PO · A {s.byClass.A} / B {s.byClass.B} / C {s.byClass.C} / D {s.byClass.D}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Replenishment queue <InfoDot text={"WHAT: the colours the replenishment rule says to order now.\n\nHOW: variants where stock + on order will not cover 30 days at the IPDOQ rate (ROP-30 above zero), the pieces called for, and how many are already at zero stock.\n\nUSE: this week's order list; per-variant quantities on Replenishment."} /></span>
          <strong>{s.replenishmentVariants != null ? inr.format(s.replenishmentVariants) : '—'}</strong>
          <small>{s.rop30Qty != null ? `${inr.format(s.rop30Qty)} pcs ROP-30` : 'no data'}{s.oosVariants != null ? ` · ${inr.format(s.oosVariants)} OOS` : ''}</small>
        </div>
        <div className="ca-kpi">
          <span className="ca-kpi-label">Discontinued on open PO <InfoDot text={"WHAT: discontinued products that are still being bought.\n\nHOW: products marked Discontinued in the Product Master that have an open PO line with pending quantity or a line on the current buying plan.\n\nUSE: should always read zero. Anything here is a wrong product state or a PO to cancel."} /></span>
          <strong className={(s.discontinuedOpenPoCount ?? 0) > 0 ? 'ca-over' : ''}>
            {s.discontinuedOpenPoCount != null ? inr.format(s.discontinuedOpenPoCount) : '—'}
          </strong>
          <small>
            {s.discontinuedOpenPoQty != null ? `${inr.format(s.discontinuedOpenPoQty)} pcs` : 'none'}
            {s.discontinuedPlanLines != null ? ` · ${inr.format(s.discontinuedPlanLines)} plan lines` : ''}
          </small>
        </div>
        {s.dataAsOf && (
          <div className="ca-kpi">
            <span className="ca-kpi-label">Stock data as of <InfoDot text={"WHAT: the date the stock figures on this page are as of.\n\nHOW: the latest nightly inventory-planning snapshot.\n\nUSE: if it is older than yesterday, the nightly sync has not run — check Sync Health before acting on the numbers."} /></span>
            <strong style={{ fontSize: 14 }}>{s.dataAsOf}</strong>
            <small>DOQ calculation feed</small>
          </div>
        )}
      </div>

      <div className="ca-dim-tabs">
        <span className="wf-subtle">ABC class</span>
        {(['All', 'A', 'B', 'C', 'D'] as const).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <span className="wf-subtle">{inr.format(rows.length)} of {inr.format(data.rows.length)} stockout gaps</span>
      </div>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wf-grid">
            <thead>
              <tr>
                <th>Variant <HeaderInfo label="Variant" /></th>
                <th>Product <HeaderInfo label="Product" /></th>
                <th>Class <HeaderInfo label="Class" /></th>
                <th className="num">Current stock <HeaderInfo label="Current stock" /></th>
                <th className="num">DOQ (45d) <HeaderInfo label="DOQ (45d)" /></th>
                <th>Status <HeaderInfo label="Status" text="Out of stock = nothing in stock and nothing on order; At risk = stock plus what is on order runs out inside the lead time." /></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ProductRow key={r.productVariant} r={r} />
              ))}
              {!rows.length && (
                <tr><td colSpan={6} className="wf-empty-cell">No stockout gaps in this class — availability is clean.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="wf-subtle" style={{ marginTop: 10 }}>
        One Product objective, one view — availability (stockout gaps + OOS), replenishment need,
        and lifecycle (discontinued products still on open POs), anchored on the product. Reuses the
        same sources as the individual dashboard cards, consolidated per the DAM one-pager principle.
      </p>
    </>
  );
}

function ProductRow({ r }: { r: ProductHubRow }) {
  return (
    <tr className={r.abcClass === 'A' ? 'wf-row-attention' : undefined}>
      <td><strong>{r.productVariant}</strong></td>
      <td>{r.productName ?? r.productCode ?? '—'}</td>
      <td><span style={{ fontWeight: 700 }}>{r.abcClass}</span></td>
      <td className="num">{inr.format(r.currentStock)}</td>
      <td className="num">{r.doq45 ? r.doq45.toFixed(1) : '—'}</td>
      <td>
        <span className={r.oos ? 'ca-over' : ''} style={{ fontWeight: 700 }}>
          {r.oos ? 'Out of stock' : 'No coverage'}
        </span>
      </td>
    </tr>
  );
}
