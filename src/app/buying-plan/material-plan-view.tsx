'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Maximize2, Minimize2 } from 'lucide-react';
import { FilterTable, type Column } from '@/components/filter-table';
import { PlanLineViews, type CardTone, type KanbanOption, type PlanCard } from './plan-line-views';
import { InfoDot } from '@/components/info-dot';
import { addMonths, statusText } from '@/lib/forms/approval';
import type { MaterialCode, MaterialType, SdStatus } from '@/lib/forms/types';

const money = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (v: string) => Number(v) || 0;

const TYPE_LABEL: Record<MaterialType, string> = { raw: 'Raw material', dyed: 'Dyed / finished', trim: 'Trims' };
const TYPE_ORDER: MaterialType[] = ['raw', 'dyed', 'trim'];

// Compact rupee for tiles: ₹1.53 Cr / ₹49.86 L / ₹94,500 — same as the FG track.
function inr(v: number) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return money.format(v);
}

export type MaterialViewItem = {
  row: {
    key: string;
    material_code: string;
    material_type: MaterialType;
    job_qty: string;
    purchase_qty: string;
    uom: string;
    remark: string;
    line_status: SdStatus | null;
    approver_edited: boolean;
  };
  cost: { job: number; fob: number } | null;
  jobValue: number;
  purchaseValue: number;
  value: number;
  missingCost: boolean;
  colour: string | null;
};

type GroupBy = 'type' | 'base' | 'uom' | 'code';

const MAT_KANBAN: KanbanOption[] = [
  {
    key: 'approval',
    label: 'Approval',
    columns: [
      { key: 'draft', title: 'Draft', tone: 'gray' },
      { key: 'submitted', title: 'With the approver', tone: 'yellow' },
      { key: 'pending_l2', title: 'With the second approver', tone: 'yellow' },
      { key: 'approved', title: 'Approved', tone: 'green' },
      { key: 'rework', title: 'Sent back', tone: 'red' },
      { key: 'rejected', title: 'Rejected', tone: 'gray' },
    ],
  },
  {
    key: 'type',
    label: 'Material type',
    columns: [
      { key: 'raw', title: 'Raw material', tone: 'blue' },
      { key: 'dyed', title: 'Dyed / finished', tone: 'violet' },
      { key: 'trim', title: 'Trims', tone: 'yellow' },
    ],
  },
  {
    key: 'route',
    label: 'Route',
    columns: [
      { key: 'job', title: 'Job Work', tone: 'blue' },
      { key: 'purchase', title: 'Purchase', tone: 'yellow' },
      { key: 'both', title: 'Both', tone: 'gray' },
    ],
  },
  { key: 'base', label: 'Base fabric' },
];
const GROUP_LABEL: Record<GroupBy, string> = { type: 'material type', base: 'base fabric', uom: 'unit', code: 'material code' };

/** "1,200 metres · 30 kg" — quantities never add across units. */
function qtyByUom(items: MaterialViewItem[]) {
  const m = new Map<string, number>();
  items.forEach((it) => {
    const q = num(it.row.job_qty) + num(it.row.purchase_qty);
    if (q) m.set(it.row.uom || 'units', (m.get(it.row.uom || 'units') ?? 0) + q);
  });
  return m.size ? [...m].map(([u, q]) => `${fmt.format(q)} ${u}`).join(' · ') : '—';
}

function routeText(items: MaterialViewItem[]) {
  const job = items.reduce((a, it) => a + num(it.row.job_qty), 0);
  const buy = items.reduce((a, it) => a + num(it.row.purchase_qty), 0);
  const parts: string[] = [];
  if (job) parts.push(`JOB ${fmt.format(job)}`);
  if (buy) parts.push(`PURCHASE ${fmt.format(buy)}`);
  return parts.length ? parts.join(' · ') : '—';
}

function Badge({ tone, children }: { tone: 'green' | 'yellow' | 'red' | 'gray'; children: React.ReactNode }) {
  return <span className={`bp-badge ${tone}`}>{children}</span>;
}

/**
 * Fabric / Material View — the FG View's layout and read-outs for the material track:
 * overview tiles, filter toolbar, plan grouped by type / base fabric / unit, the full
 * plan-detail table, and the right column (attention, value by route, value by type).
 * No issued-vs-plan figures: no material PO reaches the EasyEcom feeds, so there is
 * nothing to compare against (checked 2026-10-08) — stated on the card, not faked.
 */
export function MaterialPlanView({
  view,
  codeMap,
  planLocked,
  status,
  closedOn = null,
  planMonth,
  decision,
}: {
  /** Per-line decision control for the approver (Plan detail column); omitted otherwise. */
  decision?: (item: MaterialViewItem) => React.ReactNode;
  view: MaterialViewItem[];
  codeMap: Map<string, MaterialCode>;
  planLocked: boolean;
  status: SdStatus;
  /** Plan month when the month is over: cards read as the month's final figures. */
  closedOn?: string | null;
  planMonth: string;
}) {
  const closed = Boolean(closedOn);
  const [search, setSearch] = useState('');
  const [typeF, setTypeF] = useState<'' | MaterialType>('');
  const [routeF, setRouteF] = useState<'' | 'job' | 'purchase'>('');
  const [groupBy, setGroupBy] = useState<GroupBy>('type');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [detailExpanded, setDetailExpanded] = useState(false);

  // Same rule as FG: rejected lines and lines with no quantity are out of every total.
  const planned = view.filter(
    (v) => num(v.row.job_qty) + num(v.row.purchase_qty) > 0 && v.row.line_status !== 'rejected',
  );
  const matches = (v: MaterialViewItem) => {
    if (typeF && v.row.material_type !== typeF) return false;
    if (routeF === 'job' && !num(v.row.job_qty)) return false;
    if (routeF === 'purchase' && !num(v.row.purchase_qty)) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    const meta = codeMap.get(v.row.material_code);
    return [v.row.material_code, meta?.fabric_name, meta?.base_fabric_code, v.colour, v.row.remark]
      .some((s) => (s ?? '').toLowerCase().includes(q));
  };
  const hasFilters = Boolean(search || typeF || routeF);
  const rows = planned.filter(matches);

  const totals = planned.reduce(
    (a, v) => ({ job: a.job + v.jobValue, purchase: a.purchase + v.purchaseValue }),
    { job: 0, purchase: 0 },
  );
  const total = totals.job + totals.purchase;
  const byType = TYPE_ORDER.map((t) => {
    const items = planned.filter((v) => v.row.material_type === t);
    return { key: t, label: TYPE_LABEL[t], items, value: items.reduce((a, v) => a + v.value, 0) };
  }).filter((g) => g.items.length);
  const costed = planned.filter((v) => !v.missingCost).length;

  const attention = {
    missingCost: planned.filter((v) => v.missingCost).length,
    approvalPending: planLocked && status !== 'approved' ? planned.filter((v) => v.row.line_status !== 'approved').length : 0,
  };
  const attentionTotal = attention.missingCost + attention.approvalPending;

  const groupKey = (v: MaterialViewItem) =>
    groupBy === 'type'
      ? TYPE_LABEL[v.row.material_type]
      : groupBy === 'base'
        ? codeMap.get(v.row.material_code)?.base_fabric_code || 'No base fabric'
        : groupBy === 'uom'
          ? v.row.uom || 'No unit'
          : v.row.material_code;
  const groupMap = new Map<string, MaterialViewItem[]>();
  rows.forEach((v) => {
    const k = groupKey(v);
    groupMap.set(k, [...(groupMap.get(k) ?? []), v]);
  });
  const groupValue = (items: MaterialViewItem[]) => items.reduce((s, v) => s + v.value, 0);
  const groups = [...groupMap].sort((a, b) => groupValue(b[1]) - groupValue(a[1]));

  const frozenOn = closedOn
    ? new Date(Date.parse(addMonths(closedOn, 1)) - 86_400_000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })
    : '';

  const cols: Column<MaterialViewItem>[] = [
    { key: 'code', label: 'Material code', kind: 'mono', source: 'supabase', accessor: (v) => v.row.material_code },
    { key: 'type', label: 'Type', kind: 'text', source: 'supabase', accessor: (v) => TYPE_LABEL[v.row.material_type] },
    { key: 'name', label: 'Fabric name', kind: 'text', source: 'supabase', accessor: (v) => codeMap.get(v.row.material_code)?.fabric_name ?? '—' },
    { key: 'base', label: 'Base fabric', kind: 'text', source: 'supabase', accessor: (v) => codeMap.get(v.row.material_code)?.base_fabric_code ?? '—' },
    { key: 'colour', label: 'Colour', kind: 'text', source: 'supabase', accessor: (v) => v.colour ?? '—' },
    { key: 'job_rate', label: 'Job rate', kind: 'num', source: 'computed', accessor: (v) => v.cost?.job ?? 0,
      render: (v) => (v.cost?.job ? money.format(v.cost.job) : <span className="wf-subtle">—</span>) },
    { key: 'buy_rate', label: 'Purchase rate', kind: 'num', source: 'computed', accessor: (v) => v.cost?.fob ?? 0,
      render: (v) => (v.cost?.fob ? money.format(v.cost.fob) : <span className="wf-subtle">—</span>) },
    { key: 'job', label: 'Job qty', kind: 'num', source: 'supabase', accessor: (v) => num(v.row.job_qty) },
    { key: 'purchase', label: 'Purchase qty', kind: 'num', source: 'supabase', accessor: (v) => num(v.row.purchase_qty) },
    { key: 'uom', label: 'UOM', kind: 'text', source: 'supabase', accessor: (v) => v.row.uom },
    { key: 'value', label: 'Total value', kind: 'num', source: 'computed', accessor: (v) => v.value,
      render: (v) => (v.value ? money.format(v.value) : <span className="wf-subtle">—</span>) },
    { key: 'remark', label: 'Remark', kind: 'text', source: 'supabase', accessor: (v) => v.row.remark || '—' },
    { key: 'approval', label: 'Approval', kind: 'text', source: 'supabase',
      accessor: (v) => (v.row.line_status ? statusText(v.row.line_status, { approverEdited: v.row.approver_edited }) : '—') },
    ...(decision
      ? [{ key: 'decision', label: 'Your decision', kind: 'text' as const, source: 'supabase' as const, accessor: (v: MaterialViewItem) => v.row.line_status || 'pending', render: (v: MaterialViewItem) => decision(v) }]
      : []),
  ];

  // Plan detail as cards / kanban: lines with quantity, after the filters.
  const cards: PlanCard[] = view
    .filter((v) => num(v.row.job_qty) + num(v.row.purchase_qty) > 0)
    .filter(matches)
    .map((v) => {
      const ls = v.row.line_status;
      const tone: CardTone = ls === 'approved' ? 'green' : ls === 'rework' || ls === 'rejected' ? 'red' : ls ? 'yellow' : 'gray';
      const meta = codeMap.get(v.row.material_code);
      const job = num(v.row.job_qty);
      const buy = num(v.row.purchase_qty);
      const unit = v.row.uom || 'units';
      return {
        key: v.row.key,
        code: v.row.material_code,
        status: { text: ls ? statusText(ls, { approverEdited: v.row.approver_edited }) : statusText(status), tone },
        context: [TYPE_LABEL[v.row.material_type], meta?.fabric_name, v.colour].filter(Boolean).join(' · '),
        figs: [
          { label: 'Job Work', value: job ? `${fmt.format(job)} ${unit}` : null },
          { label: 'Purchase', value: buy ? `${fmt.format(buy)} ${unit}` : null },
        ],
        value: v.missingCost ? null : v.value,
        valueNote: !v.missingCost && total > 0 && ls !== 'rejected' ? `${((v.value / total) * 100).toFixed(1)}% of plan` : '',
        rates: v.cost ? `Job ${fmt.format(v.cost.job)} · Purchase ${fmt.format(v.cost.fob)} / ${unit}` : 'no material cost',
        tags: [
          ...(v.missingCost ? [{ text: 'No approved cost', kind: 'nocost' as const }] : []),
          ...(meta?.base_fabric_code ? [{ text: meta.base_fabric_code }] : []),
        ],
        details: [
          ['Type', TYPE_LABEL[v.row.material_type]],
          ['Fabric name', meta?.fabric_name ?? '—'],
          ['Base fabric', meta?.base_fabric_code ?? '—'],
          ['Colour', v.colour ?? '—'],
          ['Unit', unit],
          ['Job Work value', v.jobValue ? money.format(v.jobValue) : '—'],
          ['Purchase value', v.purchaseValue ? money.format(v.purchaseValue) : '—'],
          ['Plan value', v.missingCost ? 'No approved cost' : money.format(v.value)],
          ...(v.row.remark ? [['Remark', v.row.remark] as [string, string]] : []),
        ],
        sort: { value: v.value, qty: job + buy, pct: 0 },
        groups: {
          approval: ls || 'draft',
          type: v.row.material_type,
          route: job && buy ? 'both' : job ? 'job' : 'purchase',
          base: meta?.base_fabric_code || 'No base fabric',
        },
      };
    });

  const attentionItems = closed
    ? [
        { key: 'approval', dot: 'red', title: 'Never approved', sub: 'Still awaiting approval at month end', n: attention.approvalPending },
        { key: 'cost', dot: 'gray', title: 'No approved cost', sub: 'Value understated on these lines', n: attention.missingCost },
      ]
    : [
        { key: 'cost', dot: 'red', title: 'Missing approved cost', sub: 'Blocks plan value visibility', n: attention.missingCost },
        { key: 'approval', dot: 'yellow', title: 'Approval pending', sub: 'Lines waiting for action', n: attention.approvalPending },
      ];
  const liveAttention = attentionItems.filter((i) => i.n > 0);

  return (
    <div className="bp-layout">
      <div className="bp-stack">
        {/* Overview */}
        <section className="bp-card">
          <div className="bp-cardhead">
            <h2>
              {closed ? 'How the month closed' : 'Plan overview'}
              <InfoDot text={"WHAT: the material plan at a glance, in rupees.\n\nHOW: per line, Job Work qty × the approved Job rate plus Purchase qty × the approved Purchase rate (Material Standard Cost); a submitted plan keeps the value frozen at submission. Quantities are not added across units (metres, kg…).\n\nUSE: how the month's material money splits between services (Job Work) and material bought outright (Purchase)."} />
            </h2>
            <span className="wf-subtle">
              {closed ? `Final figures · frozen ${frozenOn} · ` : ''}Issued against plan: no material POs in the EasyEcom feed yet
            </span>
          </div>
          <div className="bp-cardbody">
            <div className="bp-metrics">
              <div className="bp-metric">
                <div className="label">{closed ? 'Plan value' : 'Total plan value'}</div>
                <div className="value">{total ? inr(total) : '—'}</div>
                <div className="sub">
                  {fmt.format(planned.length)} line{planned.length === 1 ? '' : 's'}
                  {byType.length > 0 && ` · ${byType.slice(0, 2).map((t) => `${t.label} ${inr(t.value)}`).join(' · ')}`}
                </div>
              </div>
              <div className="bp-metric">
                <div className="label">Job Work value</div>
                <div className="value">{totals.job ? inr(totals.job) : '—'}</div>
                <div className="sub">services (e.g. dyeing){total > 0 && totals.job ? ` · ${Math.round((totals.job / total) * 100)}% of value` : ''}</div>
              </div>
              <div className="bp-metric">
                <div className="label">Purchase value</div>
                <div className="value">{totals.purchase ? inr(totals.purchase) : '—'}</div>
                <div className="sub">bought outright{total > 0 && totals.purchase ? ` · ${Math.round((totals.purchase / total) * 100)}% of value` : ''}</div>
              </div>
              <div className="bp-metric">
                <div className="label">Lines with approved cost</div>
                <div className="value">{planned.length ? `${Math.round((costed / planned.length) * 100)}%` : '—'}</div>
                <div className="sub">{fmt.format(costed)} of {fmt.format(planned.length)} lines</div>
                <div className="bp-progress"><span style={{ width: `${planned.length ? (costed / planned.length) * 100 : 0}%` }} /></div>
              </div>
            </div>
            {byType.length > 0 && (
              <div className="bp-blend">
                <div className="bp-blend-title">Plan value by material type → route</div>
                <div className="bp-blend-grid">
                  {byType.map((t) => {
                    const job = t.items.reduce((a, v) => a + v.jobValue, 0);
                    const buy = t.items.reduce((a, v) => a + v.purchaseValue, 0);
                    return (
                      <div className="bp-blend-col" key={t.key}>
                        <div className="bp-blend-head">
                          <b>{t.label}</b>
                          <span>{t.value ? inr(t.value) : '—'} · {qtyByUom(t.items)}</span>
                        </div>
                        <div className="bp-blend-row"><span>Job Work</span><b>{job ? inr(job) : '—'}</b></div>
                        <div className="bp-blend-row"><span>Purchase</span><b>{buy ? inr(buy) : '—'}</b></div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Filters */}
        <div className="bp-sticky">
          <div className="bp-card bp-toolbar-card">
            <div className="bp-toolbar bp-filter-toolbar bp-filter-toolbar-view">
              <input
                className="bp-search"
                aria-label="Search material"
                placeholder="Search code, fabric, colour…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select aria-label="Material type" value={typeF} onChange={(e) => setTypeF(e.target.value as typeof typeF)}>
                <option value="">Type: All</option>
                {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </select>
              <select aria-label="Route" value={routeF} onChange={(e) => setRouteF(e.target.value as typeof routeF)}>
                <option value="">Route: All</option>
                <option value="job">Job Work</option>
                <option value="purchase">Purchase</option>
              </select>
              <select aria-label="Group by" value={groupBy} onChange={(e) => setGroupBy(e.target.value as GroupBy)}>
                <option value="type">Group by: Material type</option>
                <option value="base">Group by: Base fabric</option>
                <option value="uom">Group by: Unit</option>
                <option value="code">Group by: Material code</option>
              </select>
              <span className="bp-toolbar-count">
                {rows.length} of {planned.length} shown
                {hasFilters && (
                  <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => { setSearch(''); setTypeF(''); setRouteF(''); }}>
                    Clear
                  </button>
                )}
              </span>
            </div>
          </div>
        </div>

        {/* Grouped plan */}
        <section className="bp-card">
          <div className="bp-cardhead">
            <h2>
              Material plan by {GROUP_LABEL[groupBy]}
              <InfoDot text={"WHAT: the material plan rolled up by the Group By choice.\n\nHOW: value and quantity (per unit) summed within each group, after the filters above.\n\nUSE: to see where the month's material money goes."} />
            </h2>
            <div className="bp-actions">
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setCollapsed(Object.fromEntries(groups.map(([g]) => [g, true])))}>
                Collapse all
              </button>
              <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={() => setCollapsed({})}>
                Expand all
              </button>
            </div>
          </div>
          <div className="bp-cardbody">
            {!planned.length ? (
              <div className="empty-state">
                <p>{closed ? 'Nothing was planned for this month.' : 'Nothing planned yet — switch to Input to fill this month’s material plan.'}</p>
              </div>
            ) : !groups.length ? (
              <div className="wf-subtle">No lines match the filters.</div>
            ) : (
              groups.map(([name, items]) => {
                const value = items.reduce((a, v) => a + v.value, 0);
                const share = total > 0 ? Math.round((value / total) * 100) : 0;
                const missing = items.filter((v) => v.missingCost).length;
                const isCollapsed = collapsed[name];
                return (
                  <div className="bp-category" key={name}>
                    <button type="button" className="bp-cathead" onClick={() => setCollapsed((c) => ({ ...c, [name]: !c[name] }))}>
                      <div className="bp-catname">
                        <b>{isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />} {name}</b>
                        <span>{items.length} line{items.length === 1 ? '' : 's'}</span>
                      </div>
                      <div className="bp-num"><b>{qtyByUom(items)}</b><span>Plan qty</span></div>
                      <div className="bp-num"><b>{value ? inr(value) : '—'}</b><span>Plan value</span></div>
                      <div className="bp-split">{routeText(items)}</div>
                      <div><div className="bp-progress m0"><span style={{ width: `${share}%` }} /></div></div>
                      <div><Badge tone={missing ? 'red' : 'gray'}>{missing ? `${missing} no cost` : `${share}% of value`}</Badge></div>
                    </button>
                    {!isCollapsed &&
                      items.map((it) => {
                        const meta = codeMap.get(it.row.material_code);
                        const badge = it.missingCost
                          ? { tone: 'red' as const, text: 'Cost missing' }
                          : it.row.line_status === 'approved'
                            ? { tone: 'green' as const, text: 'Approved' }
                            : it.row.line_status === 'rework'
                              ? { tone: 'red' as const, text: 'Rework' }
                              : planLocked
                                ? { tone: 'yellow' as const, text: closed ? 'Never approved' : 'Awaiting' }
                                : { tone: 'gray' as const, text: 'Draft' };
                        return (
                          <div className="bp-skurow" key={it.row.key}>
                            <div className="bp-sku">
                              <b className="mono">{it.row.material_code}</b>
                              <span>{[meta?.fabric_name, it.colour].filter(Boolean).join(' · ') || TYPE_LABEL[it.row.material_type]}</span>
                            </div>
                            <div>{qtyByUom([it])}</div>
                            <div>{it.missingCost ? <span className="wf-subtle">—</span> : money.format(it.value)}</div>
                            <div className="bp-split">{routeText([it])}</div>
                            <div className="bp-split">{it.row.remark || ''}</div>
                            <div><Badge tone={badge.tone}>{badge.text}</Badge></div>
                          </div>
                        );
                      })}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Plan detail */}
        <section className={`bp-card bp-plan-detail${detailExpanded ? ' is-expanded' : ''}`}>
          <div className="bp-cardhead">
            <h2>
              Plan detail
              <InfoDot text={"WHAT: every line on this month's material plan.\n\nHOW: one row per material code with its Job Work / Purchase quantities, the approved rates, value and approval status.\n\nUSE: read-only here — search, sort, filter, download or expand. Quantities are entered on the Input view."} />
            </h2>
            <div className="bp-plan-detail-head-actions">
              <span className="wf-subtle">{view.length} lines · filter or sort any column</span>
              <button
                type="button"
                className="wf-btn wf-btn-ghost wf-btn-sm bp-plan-detail-toggle"
                aria-expanded={detailExpanded}
                onClick={() => setDetailExpanded((e) => !e)}
              >
                {detailExpanded ? <Minimize2 size={14} aria-hidden="true" /> : <Maximize2 size={14} aria-hidden="true" />}
                {detailExpanded ? 'Restore' : 'Expand'}
              </button>
            </div>
          </div>
          <div className="bp-cardbody bp-cardbody-flush">
            <PlanLineViews
              items={cards}
              storageKey="material-plan-detail-view"
              noun="material line"
              qtyUnit={null}
              kanban={MAT_KANBAN}
              decision={decision ? (key) => {
                const v = view.find((x) => x.row.key === key);
                return v ? decision(v) : null;
              } : undefined}
              table={
                <FilterTable
                  rows={view.filter(matches)}
                  columns={cols}
                  rowKey={(v) => v.row.key}
                  defaultSource="supabase"
                  unit="lines"
                  pageSize={100}
                  searchPlaceholder="Material code or status"
                  emptyText="No lines in this plan."
                  download={{ filename: `material-buying-plan-${planMonth.slice(0, 7)}` }}
                />
              }
            />
          </div>
        </section>
      </div>

      {/* Right column */}
      <div className="bp-stack bp-rightcol">
        <section className="bp-card">
          <div className="bp-cardhead">
            <h2>
              {closed ? 'Month-end lines' : 'Needs attention'}
              <InfoDot text={closed
                ? "WHAT: how the planned lines stood when the month closed.\n\nHOW: never approved = lines not approved by month end; no approved cost = no Material Standard Cost, so their value is not counted.\n\nUSE: what to carry into the next month's plan."
                : "WHAT: how many lines need someone's attention, and why.\n\nHOW: lines with no approved Material Standard Cost, and lines still awaiting approval. (Over plan / not started need material POs, which are not in the EasyEcom feed.)\n\nUSE: the review list for the plan meeting."} />
            </h2>
            {closed ? (
              <span className="wf-subtle">{fmt.format(planned.length)} planned</span>
            ) : (
              <Badge tone={attentionTotal ? 'red' : 'green'}>{attentionTotal ? `${attentionTotal} item${attentionTotal === 1 ? '' : 's'}` : 'All clear'}</Badge>
            )}
          </div>
          <div className="bp-cardbody bp-attention">
            {liveAttention.length ? (
              liveAttention.map((i) => (
                <div className="bp-issue" key={i.key}>
                  <div className="left">
                    <span className={`bp-dot ${i.dot}`} />
                    <div>
                      <b>{i.title}</b>
                      <span>{i.sub}</span>
                    </div>
                  </div>
                  <strong>{i.n}</strong>
                </div>
              ))
            ) : (
              <span className="wf-subtle">Nothing flagged for this plan.</span>
            )}
          </div>
        </section>

        <section className="bp-card">
          <div className="bp-cardhead">
            <h2>
              Planned value by route
              <InfoDot text={"WHAT: the plan's value by route.\n\nHOW: Job Work qty × the approved Job rate; Purchase qty × the approved Purchase rate (Material Standard Cost), summed.\n\nUSE: Job Work pays for a service (e.g. dyeing) on material SAADAA already owns; Purchase buys the material — two distinct budgets."} />
            </h2>
            <span className="wf-subtle">qty × approved material cost</span>
          </div>
          <div className="bp-cardbody">
            {[
              { key: 'job', label: 'Job Work', amount: totals.job, items: planned.filter((v) => num(v.row.job_qty) > 0) },
              { key: 'purchase', label: 'Purchase', amount: totals.purchase, items: planned.filter((v) => num(v.row.purchase_qty) > 0) },
            ].map((r) => (
              <div className="bp-summaryrow" key={r.key}>
                <span>
                  {r.label}
                  <small className="bp-summary-sub">
                    {r.items.length} line{r.items.length === 1 ? '' : 's'}
                    {total > 0 && r.amount ? ` · ${Math.round((r.amount / total) * 100)}% of value` : ''}
                  </small>
                </span>
                <b>{r.amount ? inr(r.amount) : '—'}</b>
              </div>
            ))}
            <div className="bp-summaryrow">
              <span>Total</span>
              <b>{total ? inr(total) : '—'}</b>
            </div>
          </div>
        </section>

        <section className="bp-card">
          <div className="bp-cardhead">
            <h2>
              Planned value by type
              <InfoDot text={"WHAT: the plan's value by material type.\n\nHOW: line values summed per type — raw material, dyed / finished fabric, trims.\n\nUSE: where the material budget goes."} />
            </h2>
          </div>
          <div className="bp-cardbody">
            {byType.length ? (
              byType.map((t) => (
                <div className="bp-summaryrow" key={t.key}>
                  <span>
                    {t.label}
                    <small className="bp-summary-sub">
                      {qtyByUom(t.items)}{total > 0 && t.value ? ` · ${Math.round((t.value / total) * 100)}% of value` : ''}
                    </small>
                  </span>
                  <b>{t.value ? inr(t.value) : '—'}</b>
                </div>
              ))
            ) : (
              <span className="wf-subtle">Nothing planned.</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
