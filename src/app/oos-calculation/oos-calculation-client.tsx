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
  { key: 'total_oos_days', label: 'Total OOS Days', kind: 'num', info: 'Days the SKU was out of stock within the 45-day window.' },
  { key: 'total_available_days', label: 'Total Available Days', kind: 'num', info: 'Days the SKU was in stock: 45 − OOS days.' },
  { key: 'total_qty_sold', label: 'Total Qty Sold', kind: 'num' },
  { key: 'doq_45', label: '45 Days DOQ', kind: 'num', info: 'Average daily sales rate (units/day) over the 45-day window, counting only in-stock days.' },
  { key: 'launch_date', label: 'Launch Date', kind: 'text', info: 'From this dataset when present, otherwise from the Product Master.' },
  { key: 'product_class', label: 'Product Class', kind: 'text', filter: 'select', info: 'ABC/D classification from IPDOQ (rules-master thresholds: A above 10/day, B ≥ 7, C ≥ 3, else D). NPD-family SKUs are not classed — they show NPD.' },
  { key: 'current_stock', label: 'Current Stock', kind: 'num' },
  { key: 'doh', label: 'DOH', kind: 'num', info: 'Days On Hand — how long current stock lasts at the recent sales rate.' },
  {
    key: 'sales_value',
    label: 'Selling Price',
    kind: 'num',
    info: 'Per-unit selling price — the live Shopify SP from the pipeline, falling back to the Product Master MRP when missing.',
  },
  {
    key: 'sales_leakage',
    label: 'Sales Leakage',
    kind: 'num',
    accessor: (r) => leakage(r),
    render: (r) => {
      const v = leakage(r);
      return v == null ? '' : <strong>{money.format(v)}</strong>;
    },
    info: 'Estimated sales value lost while out of stock: Selling Price × DOQ × OOS days.',
  },
  { key: 'inprocess_stock', label: 'Inprocess Stock', kind: 'num', info: 'Quantity on order or in production, not yet received.' },
  { key: 'doh_with_inprocess', label: 'DOH (+ Inprocess)', kind: 'num', info: 'Days On Hand counting in-process stock as available.' },
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
          OOS Calculation
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
          unit="SKUs"
          searchPlaceholder="SKU, name, variant, RM or colour"
          emptyText="No SKUs match your filters."
          download={{ filename: 'oos-calculation' }}
        />
      ) : (
        <>
          {canManage && (
            <div className="wf-toolbar" style={{ justifyContent: 'flex-start', gap: 10 }}>
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
              <InfoDot text="Excluded SKUs are hidden from the OOS Calculation tab (and its totals/exports). Restore one at any time — the data updates on the spot." />
            </div>
          )}
          <FilterTable
            rows={exclusions}
            columns={cols}
            rowKey={(r) => r.sku}
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
