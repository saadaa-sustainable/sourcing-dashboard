'use client';

import { useState, useTransition } from 'react';
import { DataAsOf } from '@/components/forms/data-as-of';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { saveAnalyticsRule } from '@/lib/forms/actions';
import { reloadWithToast } from '@/lib/toast';
import type { ReplenishmentRow } from '@/lib/forms/types';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

const COLS: Column<ReplenishmentRow>[] = [
  {
    key: 'product_variant',
    label: 'Product / colour',
    kind: 'mono',
    accessor: (r) => `${r.product_variant} ${r.product_name ?? ''} ${r.product_code ?? ''}`,
    render: (r) => (
      <>
        <span className="mono">{r.product_variant}</span>
        <small className="wf-subtle">{r.product_name ?? r.product_code}</small>
      </>
    ),
  },
  { key: 'product_state', label: 'Product State', kind: 'text', accessor: (r) => r.product_state, info: 'Lifecycle state of the product, rolled up from the product master.' },
  { key: 'current_stock', label: 'Stock', kind: 'num', info: 'Sellable stock on hand right now.' },
  { key: 'in_progress', label: 'In process', kind: 'num', info: 'Quantity already on order or in production, not yet received.' },
  { key: 'doq_45', label: 'DOQ 45', kind: 'num', info: 'Average daily sales rate (units/day) over the last 45-day window, counting only in-stock days.' },
  { key: 'doq_365', label: 'DOQ 365', kind: 'num', info: 'The same daily rate measured over the last 365 days — the stable long-window signal.' },
  {
    key: 'oos_days_45',
    label: 'OOS days',
    kind: 'num',
    info: 'Days out of stock within the last 45. Above the rules-master threshold, DOQ 45 is built on incomplete data and IPDOQ falls back to the higher of DOQ 365 / DOQ 45.',
    render: (r) =>
      r.oos_flag ? <span className="wf-over-tag">{fmt.format(r.oos_days_45)}</span> : fmt.format(r.oos_days_45),
  },
  {
    key: 'ipdoq',
    label: 'IPDOQ',
    kind: 'num',
    info: 'Inventory-Planning DOQ — the demand rate that drives the reorder quantities. DOQ 45 when the product was mostly in stock; max(DOQ 365, DOQ 45) when OOS days exceed the threshold; floored at the rules-master minimum (default 0.25/day). Both knobs are editable in the IPDOQ rules above.',
    render: (r) => <strong>{r.ipdoq}</strong>,
  },
  { key: 'rop_30', label: '30d', kind: 'num', info: 'Reorder quantity to cover the next 30 days at the IPDOQ rate, net of stock and in-process.', render: (r) => <strong>{fmt.format(r.rop_30)}</strong> },
  { key: 'rop_60', label: '60d', kind: 'num', info: 'Reorder quantity to cover the next 60 days at the IPDOQ rate, net of stock and in-process.' },
  { key: 'rop_90', label: '90d', kind: 'num', info: 'Reorder quantity to cover the next 90 days at the IPDOQ rate, net of stock and in-process.' },
];

/** Admin strip: the two IPDOQ judgement numbers, edited in the Rules Master. */
function IpdoqRules({
  isAdmin,
  threshold,
  floor,
}: {
  isAdmin: boolean;
  threshold: number;
  floor: number;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [val, setVal] = useState('');
  const [busy, start] = useTransition();

  function save(ruleKey: string) {
    const fd = new FormData();
    fd.set('rule_key', ruleKey);
    fd.set('value', val);
    start(async () => {
      const res = await saveAnalyticsRule(fd);
      setEditing(null);
      if (res.ok) reloadWithToast('Rule updated — next computation uses it.');
    });
  }

  const rules = [
    {
      key: 'oos_day_threshold',
      label: 'OOS-day threshold',
      value: threshold,
      hint: 'of 45 days',
    },
    { key: 'ipdoq_floor', label: 'IPDOQ floor', value: floor, hint: 'units/day' },
  ];

  return (
    <div className="wf-toolbar" style={{ justifyContent: 'flex-start', gap: 18 }}>
      <span className="wf-subtle" style={{ fontWeight: 650 }}>
        IPDOQ rules
        <InfoDot text="The two judgement numbers behind IPDOQ, from the editable Rules Master (sd_analytics_rule). The replenishment view reads them live — a change here affects the next computation, no redeploy." />
      </span>
      {rules.map((r) => (
        <span key={r.key} className="wf-chip">
          {r.label}:
          {editing === r.key ? (
            <>
              <input
                className="wf-mini-input"
                type="number"
                step="0.05"
                min={0}
                value={val}
                onChange={(e) => setVal(e.target.value)}
                style={{ width: 70 }}
                autoFocus
              />
              <button type="button" className="wf-btn wf-btn-primary" disabled={busy} onClick={() => save(r.key)} style={{ padding: '3px 10px', fontSize: 11 }}>
                Save
              </button>
              <button type="button" className="wf-btn wf-btn-ghost" onClick={() => setEditing(null)} style={{ padding: '3px 10px', fontSize: 11 }}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <strong>{r.value}</strong>
              <span className="wf-subtle">{r.hint}</span>
              {isAdmin && (
                <button
                  type="button"
                  className="wf-btn wf-btn-ghost"
                  style={{ padding: '2px 9px', fontSize: 11 }}
                  onClick={() => {
                    setEditing(r.key);
                    setVal(String(r.value));
                  }}
                >
                  Edit
                </button>
              )}
            </>
          )}
        </span>
      ))}
    </div>
  );
}

export function ReplenishmentClient({
  rows,
  isAdmin = false,
  oosThreshold = 30,
  ipdoqFloor = 0.25,
  dataAsOf = null,
  lastSynced = null,
}: {
  rows: ReplenishmentRow[];
  isAdmin?: boolean;
  oosThreshold?: number;
  ipdoqFloor?: number;
  dataAsOf?: string | null;
  lastSynced?: string | null;
}) {
  return (
    <>
      <DataAsOf dataAsOf={dataAsOf} lastSynced={lastSynced} />
      <IpdoqRules isAdmin={isAdmin} threshold={oosThreshold} floor={ipdoqFloor} />
      <FilterTable
        rows={rows}
        columns={COLS}
        rowKey={(r) => r.product_variant}
        rowClass={(r) => (r.oos_flag ? 'wf-row-over' : undefined)}
        unit="colours"
        searchPlaceholder="Product, colour or code"
        emptyText="Nothing needs reordering right now."
        download={{ filename: 'replenishment' }}
      />
    </>
  );
}
