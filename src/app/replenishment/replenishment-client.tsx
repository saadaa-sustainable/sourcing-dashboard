'use client';

import { useState, useTransition } from 'react';
import { DataAsOf } from '@/components/forms/data-as-of';
import { FilterTable, type Column } from '@/components/filter-table';
import { InfoDot } from '@/components/info-dot';
import { productClassOf, type ClassRules } from '@/lib/doq-dashboard';
import { saveAnalyticsRule } from '@/lib/forms/actions';
import { reloadWithToast } from '@/lib/toast';
import type { ReplenishmentRow } from '@/lib/forms/types';
import type { ProductLaunch } from '@/lib/product-launch.server';

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

// Effective-launch reference: a product with < 45 days of history has a DOQ still being
// built on a short window, so its numbers are read with caution; a product with no
// launch signal at all is surfaced as "no data", never treated as a real zero.
const buildCols = (
  classRules: ClassRules,
  launchByCode: Record<string, ProductLaunch>,
): Column<ReplenishmentRow>[] => [
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
  { key: 'product_state', label: 'Product State', kind: 'text', accessor: (r) => r.product_state, info: "WHAT: the product's lifecycle state.\n\nHOW: from the product master, rolled up to the colour — Ongoing, NPD, NPD Not Launched, To Be Discontinued, Discontinued.\n\nUSE: only Ongoing and launched NPD should be reordered; the rest are here for completeness." },
  { key: 'current_stock', label: 'Stock', kind: 'num', info: "WHAT: pieces in stock as of the snapshot.\n\nHOW: sellable stock summed across sizes for this colour.\n\nUSE: what the reorder quantities net off." },
  { key: 'in_progress', label: 'In process', kind: 'num', info: "WHAT: pieces on order that have not arrived.\n\nHOW: pending quantity on approved POs for this colour.\n\nUSE: counts as cover — the reorder quantity nets it off too." },
  { key: 'doq_45', label: 'DOQ 45', kind: 'num', info: "WHAT: DOQ 45 — pieces a day this colour sells.\n\nHOW: pieces sold in the last 45 days ÷ days in stock. Example: 60 sold over 20 stocked days → 3 a day.\n\nUSE: the recent demand rate; feeds IPDOQ." },
  { key: 'doq_365', label: 'DOQ 365', kind: 'num', info: "WHAT: DOQ 365 — the same rate over a full year.\n\nHOW: pieces sold in the last 365 days ÷ days in stock.\n\nUSE: the steady signal. IPDOQ falls back to it when the 45-day window had too many empty days to trust." },
  {
    key: 'launch',
    label: 'History',
    kind: 'text',
    filter: 'select',
    accessor: (r) => {
      const l = launchByCode[r.product_code ?? ''];
      if (!l || l.daysSinceLaunch == null) return 'No launch data';
      return l.daysSinceLaunch < 45 ? 'New (<45d)' : 'Established';
    },
    info: "WHAT: how much history this colour has — days since it effectively launched.\n\nHOW: from the first sale, unless that is before the first goods receipt, in which case from the first receipt. 'No launch data' = neither a sale nor a receipt on record.\n\nMIND: under 45 days the DOQ is built on a short window — treat the reorder quantities as a guess. 'No launch data' is not a zero; it is missing history.",
    render: (r) => {
      const l = launchByCode[r.product_code ?? ''];
      if (!l || l.daysSinceLaunch == null) return <span className="wf-subtle">no launch data</span>;
      const d = l.daysSinceLaunch;
      const title = `Effective launch ${l.effectiveLaunchDate ?? '—'}`;
      return d < 45 ? (
        <span className="wf-over-tag" title={title}>{fmt.format(d)}d · new</span>
      ) : (
        <span title={title}>{fmt.format(d)}d</span>
      );
    },
  },
  {
    key: 'oos_days_45',
    label: 'OOS days',
    kind: 'num',
    info: "WHAT: how many of the last 45 days this colour was empty.\n\nHOW: days with zero stock in the window.\n\nUSE: above the Rules Master threshold (default 30) the 45-day DOQ is built on too few selling days, so IPDOQ switches to the higher of DOQ 365 and DOQ 45.",
    render: (r) =>
      r.oos_flag ? <span className="wf-over-tag">{fmt.format(r.oos_days_45)}</span> : fmt.format(r.oos_days_45),
  },
  {
    key: 'ipdoq',
    label: 'IPDOQ',
    kind: 'num',
    info: "WHAT: IPDOQ — the demand rate every reorder quantity on this page is built on.\n\nHOW: DOQ 45 when the colour was mostly in stock; the higher of DOQ 365 and DOQ 45 when out-of-stock days exceed the threshold; never below the floor (default 0.25 a day). Threshold and floor are the two rules at the top of this page (Rules Master).\n\nUSE: change the rules, not the number — a change applies to every colour on the next load.",
    render: (r) => <strong>{r.ipdoq}</strong>,
  },
  {
    key: 'product_class',
    label: 'Class',
    kind: 'text',
    filter: 'select',
    accessor: (r) =>
      // Sales class only — the product state is a separate dimension and has its own column.
      productClassOf(r.ipdoq ?? 0, classRules),
    info: "WHAT: the sales class — how fast the colour sells.\n\nHOW: from IPDOQ: A above 10 a day, B 7 or more, C 3 or more, else D (Rules Master). NPD-family products show no class — no history yet.\n\nMIND: speed only. D does NOT mean discontinued; discontinuation is a product state decided on the Discontinue page.",
  },
  { key: 'rop_30', source: 'computed', label: '30d', kind: 'num', info: "WHAT: ROP 30 — how many pieces to order to stay in stock for the next 30 days.\n\nHOW: 30 × IPDOQ − stock − in-process, never below 0. Example: 3 a day × 30 = 90 needed; 40 in stock, 20 on order → order 30.\n\nUSE: the 30-day horizon suits Job Work (30-day lead time). Zero means covered.", render: (r) => <strong>{fmt.format(r.rop_30)}</strong> },
  { key: 'rop_60', source: 'computed', label: '60d', kind: 'num', info: "WHAT: ROP 60 — pieces to order to stay in stock for 60 days.\n\nHOW: 60 × IPDOQ − stock − in-process, never below 0.\n\nUSE: the horizon for E-FOB (45-day lead time plus buffer)." },
  { key: 'rop_90', source: 'computed', label: '90d', kind: 'num', info: "WHAT: ROP 90 — pieces to order to stay in stock for 90 days.\n\nHOW: 90 × IPDOQ − stock − in-process, never below 0.\n\nUSE: the horizon for FOB (75-day lead time plus buffer). If this is large and nothing is on order, the FOB PO is already late." },
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
    <div className="chip-row">
      <span className="chip-row-label">
        IPDOQ rules
        <InfoDot text={"WHAT: the two settings that decide how IPDOQ is worked out.\n\nHOW: OOS-day threshold — above this many empty days in 45, the 45-day DOQ is not trusted and the year's rate is used instead. IPDOQ floor — the lowest rate any colour is given, so slow sellers still get a minimum reorder. Both live in Rules Master.\n\nUSE: change them here and every reorder quantity updates on the next load — no deploy, no formula edits."} />
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
  launchByCode = {},
  isAdmin = false,
  oosThreshold = 30,
  ipdoqFloor = 0.25,
  classRules = { aAbove: 10, bMin: 7, cMin: 3 },
  dataAsOf = null,
  lastSynced = null,
}: {
  rows: ReplenishmentRow[];
  launchByCode?: Record<string, ProductLaunch>;
  isAdmin?: boolean;
  oosThreshold?: number;
  ipdoqFloor?: number;
  classRules?: ClassRules;
  dataAsOf?: string | null;
  lastSynced?: string | null;
}) {
  return (
    <>
      <DataAsOf dataAsOf={dataAsOf} lastSynced={lastSynced} />
      <IpdoqRules isAdmin={isAdmin} threshold={oosThreshold} floor={ipdoqFloor} />
      <FilterTable
        rows={rows}
        columns={buildCols(classRules, launchByCode)}
        rowKey={(r) => r.product_variant}
        defaultSource="bigquery"
        rowClass={(r) => (r.oos_flag ? 'wf-row-over' : undefined)}
        unit="colours"
        searchPlaceholder="Product, colour or code"
        emptyText="Nothing needs reordering right now."
        download={{ filename: 'replenishment' }}
      />
    </>
  );
}
