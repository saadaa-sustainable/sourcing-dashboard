'use client';

import { useMemo, useState, useTransition } from 'react';
import { DataAsOf } from '@/components/forms/data-as-of';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { addOosExclusion, removeOosExclusion } from '@/lib/forms/actions';
import { reloadWithToast } from '@/lib/toast';
import type { OosCalculationRow, OosSkuExclusion } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** Sales Leakage = Selling Price × DOQ × OOS Days (spec item 4). */
const leakage = (r: OosCalculationRow): number | null =>
  r.sales_value != null && r.doq_45 != null && r.total_oos_days != null
    ? Math.round(r.sales_value * r.doq_45 * r.total_oos_days)
    : null;

// The full sheet, column-for-column. Per-column filters + click-to-sort come from FilterTable.
const COLS: Column<OosCalculationRow>[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'product_status', label: 'Product State', kind: 'text' },
  { key: 'category_with_gender', label: 'Category w/ Gender', kind: 'text' },
  { key: 'rm_code', label: 'RM Code', kind: 'mono' },
  { key: 'dyed_fabric_sku', label: 'Dyed Fabric SKU', kind: 'mono' },
  { key: 'product_variant', label: 'Product Variant', kind: 'mono' },
  { key: 'product_code', label: 'Product Code', kind: 'mono' },
  { key: 'product_name', label: 'Product Name', kind: 'text' },
  { key: 'color', label: 'Colour', kind: 'text' },
  { key: 'size', label: 'Size', kind: 'text' },
  { key: 'total_oos_days', label: 'Total OOS Days', kind: 'num', info: "WHAT: how many of the last 45 days this SKU had no stock.\n\nHOW: days with stock at zero in the 45-day window (oos_days_45 from the inventory feed).\n\nUSE: 45 of 45 means it was never in stock in the window — either a stock-out the whole time or a SKU that is not really being sold." },
  { key: 'total_available_days', label: 'Total Available Days', kind: 'num', info: "WHAT: how many of the last 45 days the SKU could actually sell.\n\nHOW: 45 − days out of stock.\n\nUSE: the denominator for the DOQ: sales are divided by these days, not by 45." },
  { key: 'total_qty_sold', label: 'Total Qty Sold', kind: 'num' },
  { key: 'doq_45', label: '45 Days DOQ', kind: 'num', info: "WHAT: DOQ 45 — pieces a day this SKU sells.\n\nHOW: pieces sold in the last 45 days ÷ days in stock. Example: 60 sold over 20 stocked days → 3 a day, not 60 ÷ 45.\n\nUSE: the rate ordering is built on; empty days do not drag it down." },
  { key: 'launch_date', label: 'Launch Date', kind: 'text', info: "WHAT: the product's launch date.\n\nHOW: from the inventory feed when it has one, otherwise from the EasyEcom Product Master.\n\nUSE: a SKU launched inside the window has fewer days of history — read its DOQ with caution." },
  { key: 'product_class', label: 'Product Class', kind: 'text', filter: 'select', source: 'computed', info: "WHAT: the sales class — how fast this SKU sells.\n\nHOW: from IPDOQ: A above 10 a day, B 7 or more, C 3 or more, else D. Thresholds in Rules Master.\n\nMIND: this is speed only. It is independent of the product state — an NPD or To-Be-Discontinued product still has a class, and D does NOT mean discontinued. A is the first to keep in stock." },
  { key: 'current_stock', label: 'Current Stock', kind: 'num' },
  { key: 'doh', label: 'DOH', kind: 'num', info: "WHAT: DOH — how many days the stock lasts.\n\nHOW: current stock ÷ DOQ 45. Example: 300 in stock, 5 a day → 60 days.\n\nUSE: read against the lead time (Job 30, E-FOB 45, FOB 90 days in Rules Master). Under the lead time = order now." },
  {
    key: 'sales_value',
    label: 'Selling Price',
    kind: 'num',
    info: "WHAT: what one piece sells for.\n\nHOW: the live Shopify selling price; MRP from the Product Master when Shopify has none.\n\nUSE: multiplies into Sales Leakage.",
  },
  {
    key: 'sales_leakage',
    source: 'computed',
    label: 'Sales Leakage',
    kind: 'num',
    accessor: (r) => leakage(r),
    render: (r) => {
      const v = leakage(r);
      return v == null ? '' : <strong>{money.format(v)}</strong>;
    },
    info: "WHAT: the sales lost while this SKU was empty, in rupees.\n\nHOW: selling price × DOQ 45 × days out of stock. Example: ₹899 × 3 a day × 10 days → ₹26,970.\n\nUSE: the cost of the stock-out; sort by it to find the expensive gaps.",
  },
  { key: 'inprocess_stock', label: 'Inprocess Stock', kind: 'num', info: "WHAT: pieces on order that have not arrived.\n\nHOW: pending quantity on approved POs.\n\nUSE: counts as cover in the next column." },
  { key: 'doh_with_inprocess', label: 'DOH (+ Inprocess)', kind: 'num', info: "WHAT: days of cover including what is on order.\n\nHOW: (current stock + in-process) ÷ DOQ 45.\n\nUSE: if this is still under the lead time, the pieces on order are not enough — order more." },
  { key: 'weave_type', label: 'Weave Type', kind: 'text' },
];

const EXCLUDED_COLS: Column<OosSkuExclusion>[] = [
  { key: 'sku', label: 'SKU', kind: 'mono' },
  { key: 'reason', label: 'Reason', kind: 'text' },
  { key: 'added_by', label: 'Excluded by', kind: 'text' },
  { key: 'added_at', label: 'On', kind: 'text', accessor: (r) => String(r.added_at).slice(0, 10) },
];

export function OosCalculationClient({
  rows,
  exclusions,
  canManage,
  dataAsOf,
  lastSynced,
}: {
  rows: OosCalculationRow[];
  exclusions: OosSkuExclusion[];
  canManage: boolean;
  dataAsOf: string | null;
  lastSynced: string | null;
}) {
  const [tab, setTab] = useState<'calc' | 'excluded'>('calc');
  const [sku, setSku] = useState('');
  const [reason, setReason] = useState('');
  const [busy, start] = useTransition();

  const excludedSet = useMemo(
    () => new Set(exclusions.map((e) => e.sku.toUpperCase())),
    [exclusions],
  );
  const visible = useMemo(
    () => rows.filter((r) => !excludedSet.has(r.sku.toUpperCase())),
    [rows, excludedSet],
  );

  function add() {
    const fd = new FormData();
    fd.set('sku', sku);
    fd.set('reason', reason);
    start(async () => {
      const res = await addOosExclusion(fd);
      if (res.ok) {
        setSku('');
        setReason('');
        reloadWithToast(res.message);
      } else {
        reloadWithToast(res.error ?? 'Could not exclude.');
      }
    });
  }

  function remove(target: string) {
    const fd = new FormData();
    fd.set('sku', target);
    start(async () => {
      const res = await removeOosExclusion(fd);
      reloadWithToast(res.ok ? res.message : (res.error ?? 'Could not remove.'));
    });
  }

  const cols: Column<OosSkuExclusion>[] = canManage
    ? [
        ...EXCLUDED_COLS,
        {
          key: '_actions',
          label: '',
          filter: 'none',
          accessor: () => '',
          render: (r) => (
            <button
              type="button"
              className="wf-btn wf-btn-ghost"
              style={{ padding: '3px 10px', fontSize: 11 }}
              disabled={busy}
              onClick={() => remove(r.sku)}
            >
              Restore
            </button>
          ),
        },
      ]
    : EXCLUDED_COLS;

  return (
    <>
      {/* Spec item 1: the snapshot date whose data this tab is showing. */}
      <DataAsOf dataAsOf={dataAsOf} lastSynced={lastSynced}>
        <span className="wf-chip">
          {money.format(visible.length)} SKUs · {money.format(exclusions.length)} excluded
        </span>
      </DataAsOf>

      <div className="role-tabs" role="tablist" aria-label="OOS views">
        <button role="tab" aria-selected={tab === 'calc'} className={tab === 'calc' ? 'active' : ''} onClick={() => setTab('calc')}>
          DOQ Calculation
        </button>
        <button role="tab" aria-selected={tab === 'excluded'} className={tab === 'excluded' ? 'active' : ''} onClick={() => setTab('excluded')}>
          Excluded SKUs ({exclusions.length})
        </button>
      </div>

      {tab === 'calc' ? (
        <FilterTable
          rows={visible}
          columns={COLS}
          rowKey={(r) => r.sku}
          defaultSource="bigquery"
          unit="SKUs"
          searchPlaceholder="SKU, name, variant, RM or colour"
          emptyText="No SKUs match your filters."
          download={{ filename: 'oos-calculation' }}
        />
      ) : (
        <>
          {canManage && (
            <div className="chip-row">
              <input
                className="wf-search"
                placeholder="SKU to exclude"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                style={{ minWidth: 220 }}
              />
              <input
                className="wf-search"
                placeholder="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                style={{ minWidth: 260 }}
              />
              <button type="button" className="wf-btn wf-btn-primary" disabled={busy || !sku.trim()} onClick={add}>
                Exclude SKU
              </button>
              <InfoDot text={"WHAT: SKUs deliberately hidden from this page, its totals and exports.\n\nHOW: the shared exclusion list, same as the OOS Dashboard's.\n\nUSE: test SKUs and samples only. Restore any time; the data updates on the spot."} />
            </div>
          )}
          <FilterTable
            rows={exclusions}
            columns={cols}
            rowKey={(r) => r.sku}
            defaultSource="supabase"
            unit="SKUs"
            searchPlaceholder="SKU, reason or person"
            emptyText="No SKUs are excluded — everything counts toward the calculation."
            download={{ filename: 'oos-excluded-skus' }}
          />
        </>
      )}
    </>
  );
}
