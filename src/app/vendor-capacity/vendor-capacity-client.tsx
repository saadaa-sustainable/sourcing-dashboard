'use client';

import { confirmDelete } from '@/lib/confirm';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { reloadWithToast, toastError } from '@/lib/toast';
import { HeaderInfo } from '@/components/header-info';
import { AlertTriangle, Clock, Download, Info, Lock, Save, Search, Plus, Trash2, ArrowUpRight } from 'lucide-react';
import {
  saveVendorCapacityRow,
  saveVendorProductAllocation,
  deleteVendorProductAllocation,
} from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { useColumnSort } from '@/lib/use-column-sort';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import { ClearFiltersButton } from '@/components/clear-filters-button';
import { DeboardedPill } from '@/components/forms/deboarded-pill';
import {
  DEFAULT_CAPACITY_RULES,
  VENDOR_TYPE_MULTIPLIER,
  normaliseVendorType,
  vendorCapacityModel,
  type CapacityModel,
  type CapacityRules,
} from '@/lib/business-logic';
import { capacityLocked, capacityWeekNext, capacityWeekStart } from '@/lib/forms/approval';
import type {
  DeboardedVendor,
  SdRole,
  VendorCapacityLog,
  VendorProductAllocation,
  VendorTypeMultiplier,
  ProductCatalogItem,
} from '@/lib/forms/types';
import './vendor-capacity.css';
import { OVER_UTILISED, isOverUtilised, utilisationLabel } from '@/lib/utilisation';

type Vendor = {
  vendor_code: string;
  vendor_name: string;
  vendor_type: string;
  merchant: string;
  machinesAtOnboarding: number;
  capacitySigned: number;
  inProcessQty: number;
  current: VendorCapacityLog | null;
  deboarded?: DeboardedVendor | null;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;
const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 86_400_000;

const typeConfig = (type: string) => VENDOR_TYPE_MULTIPLIER[normaliseVendorType(type)];

/** The one capacity model, fed from the vendor's current sheet row. */
function modelOf(vendor: Vendor, rules: CapacityRules): CapacityModel {
  return vendorCapacityModel(
    {
      machines: vendor.current?.machines_allocated,
      karigar: vendor.current?.active_karigar,
      vendorType: vendor.vendor_type,
      inProcessQty: vendor.inProcessQty,
    },
    rules,
  );
}

function ageLabel(iso: string | null, now: number | null) {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  const label = new Date(iso).toLocaleDateString('en-IN');
  if (now == null) return label;
  const days = Math.floor((now - then) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return `${label} · ${days}d ago`;
}

const TABS = [
  ['entry', 'Entry'],
  ['allocation', 'Product Allocation'],
  ['rules', 'Rules'],
  ['reporting', 'Reporting'],
] as const;
type TabId = (typeof TABS)[number][0];

function CapacityMetric({
  label,
  value,
  detail,
  tone = 'green',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'green' | 'blue' | 'amber' | 'red';
}) {
  return (
    <div className={`vc-metric vc-metric-${tone}`}>
      <span className="vc-metric-label">{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

/**
 * A utilisation cell. At or past 100% the number stops being the useful thing — 2,815% and
 * 1,833% are both simply over — so the cell states the condition instead. Under 100% it keeps
 * the figure and the bar, where the exact value still tells you how much room is left.
 */
function UtilCell({ value }: { value: number | null }) {
  if (value == null) return <span className="wf-subtle">—</span>;
  if (isOverUtilised(value)) return <span className="vc-over-text">{OVER_UTILISED}</span>;
  return (
    <>
      <span className={`vc-pill ${value >= 85 ? 'vc-pill-amber' : 'vc-pill-green'}`}>
        {utilisationLabel(value)}
      </span>
      <CapacityBar value={value} />
    </>
  );
}

function CapacityBar({ value }: { value: number | null }) {
  return (
    <span className="vc-progress" aria-hidden="true">
      <span
        className={value != null && value > 100 ? 'vc-progress-over' : value != null && value >= 85 ? 'vc-progress-warn' : ''}
        style={{ width: `${Math.min(Math.max(value ?? 0, 0), 100)}%` }}
      />
    </span>
  );
}

function downloadCsv(name: string, rows: (string | number | null)[][]) {
  const csv = rows
    .map((row) => row.map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`).join(','))
    .join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ------------------------------ Shell (item 6) ------------------------------ */

/** Entry: the running week is the editable sheet; a past week is the view-only page. */
function EntryForWeek(props: Parameters<typeof EntryTab>[0]) {
  return props.asOf ? <EntryTab {...props} /> : <LiveEntryTab {...props} />;
}


export function VendorCapacityClient({
  vendors,
  role,
  allocations = [],
  catalog = [],
  leadDays,
  multipliers = [],
  rules = DEFAULT_CAPACITY_RULES,
  asOf = null,
}: {
  vendors: Vendor[];
  role: SdRole;
  /** A past week opened from the board: vendors carry that week's figures; read-only. */
  asOf?: { week: string; label: string; inProcessKept: boolean } | null;
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  leadDays: { job: number; efob: number; fob: number };
  /** Vendor-type multipliers straight from the sd_vendor_type_multiplier master. */
  multipliers?: VendorTypeMultiplier[];
  /** Every capacity number reads these; from Rules Master (capacityRulesFrom). */
  rules?: CapacityRules;
}) {
  const [tab, setTab] = useState<TabId>('entry');
  // Click-through: Reporting → Entry/Allocation focused on one vendor.
  const [focusVendor, setFocusVendor] = useState('');

  return (
    <div className="vc-page">
      <div className="role-tabs vc-tabs" role="tablist" aria-label="Vendor Capacity sections">
        {TABS.filter(([id]) => !asOf || id === 'entry' || id === 'reporting').map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'entry' && (
        <EntryForWeek
          vendors={vendors}
          asOf={asOf}
          role={role}
          initialSearch={focusVendor}
          allocations={allocations}
          catalog={catalog}
          rules={rules}
        />
      )}
      {tab === 'allocation' && (
        <ProductAllocationTab
          vendors={vendors}
          allocations={allocations}
          catalog={catalog}
          role={role}
          initialVendor={focusVendor}
        />
      )}
      {tab === 'rules' && (
        <RulesTab
          leadDays={leadDays}
          multipliers={multipliers}
          rules={rules}
        />
      )}
      {tab === 'reporting' && (
        <ReportingTab
          vendors={vendors}
          rules={rules}
          onVendor={(code) => {
            setFocusVendor(code);
            setTab('allocation');
          }}
        />
      )}
    </div>
  );
}

/* -------------------------- Entry tab: a past week -------------------------- */

type AsOf = { week: string; label: string; inProcessKept: boolean } | null;
type Edit = { machines_allocated?: string; active_karigar?: string };
type EntryFilter = 'all' | 'over' | 'stale' | 'due' | 'none';
type InputField = 'machines_allocated' | 'active_karigar';
const INPUT_FIELDS: InputField[] = ['machines_allocated', 'active_karigar'];

/**
 * The week's capacity sheet, Shopify-admin style: one summary strip (the attention figures
 * filter the table), filter tabs, one table, one save bar. A past week (asOf) is view only.
 * In the running week the boxes start blank for a vendor not yet updated since Monday; every
 * figure keeps using the vendor's last saved numbers until new ones are saved.
 */
function EntryTab({
  vendors,
  asOf = null,
  role,
  initialSearch,
  allocations = [],
  catalog = [],
  rules = DEFAULT_CAPACITY_RULES,
}: {
  vendors: Vendor[];
  asOf?: AsOf;
  role: SdRole;
  initialSearch?: string;
  /** Product allocations, so the sheet can be narrowed to who makes a given product. */
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  rules?: CapacityRules;
}) {
  const live = !asOf;
  const editable = live && canEdit(role, 'draft');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [merchant, setMerchant] = useState('');
  const [vType, setVType] = useState('');
  const [product, setProduct] = useState('');
  const [filter, setFilter] = useState<EntryFilter>('all');
  // Clear all filters: search (even one opened from a vendor link), every chip and the status tab.
  const filtersActive = search !== '' || merchant !== '' || vType !== '' || product !== '' || filter !== 'all';
  const clearFilters = () => {
    setSearch('');
    setMerchant('');
    setVType('');
    setProduct('');
    setFilter('all');
  };
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Client-only "now", set once after mount so the server render never disagrees
    // on staleness (hydration-safe) — an intentional set-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
  }, []);

  const merchants = useMemo(() => [...new Set(vendors.map((v) => v.merchant.trim()).filter(Boolean))].sort(), [vendors]);
  const vTypes = useMemo(() => [...new Set(vendors.map((v) => v.vendor_type.trim()).filter(Boolean))].sort(), [vendors]);
  const allocatedProducts = useMemo(
    () => [...new Set(allocations.map((a) => (a.product_code ?? '').trim()).filter(Boolean))].sort(),
    [allocations],
  );
  /** Vendors carrying an allocation for the chosen product code. */
  const vendorsForProduct = useMemo(() => {
    if (!product) return null;
    const want = product.trim().toUpperCase();
    return new Set(
      allocations
        .filter((a) => (a.product_code ?? '').trim().toUpperCase() === want)
        .map((a) => (a.vendor_code ?? '').trim().toUpperCase()),
    );
  }, [allocations, product]);

  const weekStartMs = Date.parse(`${capacityWeekStart()}T00:00:00+05:30`);
  // Staleness is judged at the end of the week shown (a past week) or right now.
  const ref = asOf ? Date.parse(`${capacityWeekNext(new Date(`${asOf.week}T12:00:00+05:30`))}T00:00:00+05:30`) : now;

  const decorated = useMemo(
    () =>
      vendors.map((vendor) => {
        const code = vendor.vendor_code;
        const lastUpdated = vendor.current?.entry_date ?? null;
        const thisWeek = live && lastUpdated != null && Date.parse(lastUpdated) >= weekStartMs;
        const last: Record<InputField, string> = {
          machines_allocated: vendor.current?.machines_allocated?.toString() ?? '',
          active_karigar: vendor.current?.active_karigar?.toString() ?? '',
        };
        // What the box shows: this week's figures, or blank for a vendor not yet updated.
        const baseline: Record<InputField, string> = thisWeek ? last : { machines_allocated: '', active_karigar: '' };
        const edit = edits[code] ?? {};
        const shown: Record<InputField, string> = {
          machines_allocated: edit.machines_allocated ?? baseline.machines_allocated,
          active_karigar: edit.active_karigar ?? baseline.active_karigar,
        };
        const dirty = INPUT_FIELDS.some((f) => shown[f] !== baseline[f]);
        // What counts: a typed figure, else the last saved one (a blank box is not zero).
        const effective: Record<InputField, string> = {
          machines_allocated: shown.machines_allocated !== '' ? shown.machines_allocated : last.machines_allocated,
          active_karigar: shown.active_karigar !== '' ? shown.active_karigar : last.active_karigar,
        };
        const m = vendorCapacityModel(
          { machines: num(effective.machines_allocated), karigar: num(effective.active_karigar), vendorType: vendor.vendor_type, inProcessQty: vendor.inProcessQty },
          rules,
        );
        const isStale = ref != null && (!lastUpdated || ref - new Date(lastUpdated).getTime() > STALE_MS);
        return { vendor, code, lastUpdated, thisWeek, last, shown, dirty, effective, m, isStale };
      }),
    [vendors, edits, rules, ref, live, weekStartMs],
  );
  type Row = (typeof decorated)[number];

  const matches: Record<EntryFilter, (d: Row) => boolean> = {
    all: () => true,
    over: (d) => d.m.over,
    stale: (d) => d.isStale,
    due: (d) => !d.thisWeek,
    none: (d) => !d.m.entered,
  };
  const tabs: [EntryFilter, string][] = [
    ['all', 'All'],
    ['over', 'Over capacity'],
    live ? ['due', 'Due this week'] : ['stale', 'Stale'],
    ['none', 'Not entered'],
  ];

  const q = search.trim().toLowerCase();
  const filtered = decorated
    .filter(matches[filter])
    .filter(({ vendor }) => (q ? `${vendor.vendor_code} ${vendor.vendor_name}`.toLowerCase().includes(q) : true))
    .filter(({ vendor }) => (merchant ? vendor.merchant.trim() === merchant : true))
    .filter(({ vendor }) => (vType ? vendor.vendor_type.trim() === vType : true))
    .filter(({ vendor }) => (vendorsForProduct ? vendorsForProduct.has(vendor.vendor_code.trim().toUpperCase()) : true))
    .sort((a, b) => a.vendor.vendor_name.localeCompare(b.vendor.vendor_name));
  const sort = useColumnSort<Row>();

  // Totals count only vendors with capacity on record; "Not entered" is not zero capacity.
  const entered = decorated.filter((d) => d.m.entered);
  const totalPo = entered.reduce((t, d) => t + d.m.poCapacity, 0);
  const totalMonthly = entered.reduce((t, d) => t + d.m.capacityPerMonth, 0);
  const totalOnOrder = entered.reduce((t, d) => t + d.vendor.inProcessQty, 0);
  const overCount = decorated.filter(matches.over).length;
  const staleCount = decorated.filter(matches.stale).length;
  const dueCount = decorated.filter(matches.due).length;
  const dirtyRows = decorated.filter((d) => d.dirty);

  function setField(code: string, field: InputField, value: string) {
    const clean = value.replace(/[^0-9]/g, '');
    setEdits((cur) => ({ ...cur, [code]: { ...cur[code], [field]: clean } }));
    setErrors((cur) => {
      if (!cur[code]) return cur;
      const next = { ...cur };
      delete next[code];
      return next;
    });
  }

  async function saveAll() {
    if (!dirtyRows.length) return;
    setSaving(true);
    const failed: Record<string, string> = {};
    let saved = 0;
    for (const d of dirtyRows) {
      const payload = new FormData();
      payload.set('vendor_code', d.vendor.vendor_code);
      payload.set('vendor_name', d.vendor.vendor_name);
      payload.set('machines_allocated', d.effective.machines_allocated);
      payload.set('active_karigar', d.effective.active_karigar);
      payload.set('capacity_per_month', String(d.m.capacityPerMonth || ''));
      const result = await saveVendorCapacityRow(payload);
      if (result.ok) saved += 1;
      else failed[d.code] = toastError(result.error);
    }
    setSaving(false);
    setErrors(failed);
    setEdits((cur) => Object.fromEntries(Object.entries(cur).filter(([code]) => failed[code])));
    if (saved) reloadWithToast(`Saved ${saved} vendor${saved === 1 ? '' : 's'}.`);
  }

  function exportRows() {
    downloadCsv(asOf ? `vendor-capacity-week-${asOf.week}.csv` : 'vendor-capacity.csv', [
      ['Vendor code', 'Vendor', 'Merchandiser', 'Type', 'Machines', 'Karigars', 'Capacity/month', 'First machines', 'PO capacity', 'On order', 'Available', 'Machine util %', 'Capacity used', 'Last updated'],
      ...sort.apply(filtered).map(({ vendor, effective, m, lastUpdated }) => [
        vendor.vendor_code, vendor.vendor_name, vendor.merchant, vendor.vendor_type,
        effective.machines_allocated, effective.active_karigar,
        m.entered ? m.capacityPerMonth : 'Not entered', vendor.machinesAtOnboarding,
        m.entered ? m.poCapacity : 'Not entered', vendor.inProcessQty,
        m.entered ? m.available : '', m.machineUtil ?? '', m.entered ? utilisationLabel(m.capacityUtil) : '', lastUpdated,
      ]),
    ]);
  }

  const dayLabel = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';
  const colCount = 10;

  return (
    <div className="vc-section vc2">
      <section className="vc2-card vc2-summary" aria-label="Summary">
        <div className="vc2-metric">
          <span className="vc2-k" title="What the vendors can make inside their PO lead times">PO capacity</span>
          <strong>{fmt.format(totalPo)}</strong>
          <small>{entered.length} vendors · {fmt.format(totalMonthly)} pcs / month</small>
        </div>
        <div className="vc2-metric">
          <span className="vc2-k" title="Pieces on approved POs not yet received">On order</span>
          <strong>{fmt.format(totalOnOrder)}</strong>
          <small>{totalPo ? `${Math.round((totalOnOrder / totalPo) * 100)}% of PO capacity` : 'pcs in production'}</small>
        </div>
        <button type="button" className="vc2-metric is-crit" onClick={() => setFilter('over')}>
          <span className="vc2-k">Over capacity</span>
          <strong>{overCount}</strong>
          <small>more on order than PO capacity</small>
        </button>
        {live ? (
          <button type="button" className="vc2-metric is-warn" onClick={() => setFilter('due')}>
            <span className="vc2-k">Due this week</span>
            <strong>{dueCount} <em>of {decorated.length}</em></strong>
            <small>not updated since Monday</small>
          </button>
        ) : (
          <button type="button" className="vc2-metric is-warn" onClick={() => setFilter('stale')}>
            <span className="vc2-k">Stale</span>
            <strong>{staleCount}</strong>
            <small>last update over {STALE_DAYS} days old</small>
          </button>
        )}
      </section>

      <div className="vc2-banner" role="note">
        <Info size={16} aria-hidden="true" />
        <div>
          {asOf ? (
            <p>
              <b>Figures as entered by the end of this week.</b>{' '}
              {asOf.inProcessKept
                ? 'On order is what was on order at the end of the week.'
                : 'On order uses today’s open POs; the weekly in-process copy started after this week.'}
            </p>
          ) : (
            <p>
              <b>New week, blank boxes.</b> The small grey figure under a box is the vendor’s last saved value; every
              figure keeps using it until a new one is saved. Update on any day of the week (Monday to Sunday).
            </p>
          )}
          <details>
            <summary>How figures are worked out</summary>
            <ul>
              <li>Capacity / month = {rules.driverMinMachines ? 'min(machines, karigars)' : 'karigars'} × {rules.dailyOutput} pieces × {rules.workingDays} working days.</li>
              <li>PO capacity = capacity / month × lead days ÷ 30 (Job Work {rules.leadDays.job_work} d · E-FOB {rules.leadDays.efob} d · FOB {rules.leadDays.fob} d).</li>
              <li>Available = PO capacity − on order. Capacity used = on order ÷ PO capacity; past capacity it reads “100% Over Utilised”.</li>
              <li>Machine util = karigars ÷ machines. A vendor with no karigars on record is left out of every total.</li>
              <li>Type and first machines come from the vendor master. A vendor not updated in over {STALE_DAYS} days is stale.</li>
            </ul>
          </details>
        </div>
      </div>

      <section className="vc2-card" aria-label="Vendors">
        <div className="vc2-tabs" role="tablist" aria-label="Show">
          {tabs.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={filter === id} className="vc2-tab" onClick={() => setFilter(id)}>
              {label}
              <span className="vc2-n">{decorated.filter(matches[id]).length}</span>
            </button>
          ))}
        </div>
        <div className="vc2-toolbar plan-filterbar">
          <label className="vc2-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" value={search} placeholder="Search vendor name or code" aria-label="Search vendors" onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select className={`vc2-chip${merchant ? ' is-on' : ''}`} aria-label="Merchandiser" value={merchant} onChange={(e) => setMerchant(e.target.value)}>
            <option value="">Merchandiser</option>
            {merchants.map((m) => <option key={m}>{m}</option>)}
          </select>
          <select className={`vc2-chip${vType ? ' is-on' : ''}`} aria-label="PO type" value={vType} onChange={(e) => setVType(e.target.value)}>
            <option value="">PO type</option>
            {vTypes.map((t) => <option key={t} value={t}>{typeConfig(t)?.label ?? t}</option>)}
          </select>
          {allocatedProducts.length > 0 && (
            <select className={`vc2-chip${product ? ' is-on' : ''}`} aria-label="Product" value={product} onChange={(e) => setProduct(e.target.value)}>
              <option value="">Product</option>
              {allocatedProducts.map((code) => {
                const name = catalog.find((c) => c.product_code === code)?.product_name;
                return <option key={code} value={code}>{code}{name ? ` · ${name}` : ''}</option>;
              })}
            </select>
          )}
          <ClearFiltersButton active={filtersActive} onClear={clearFilters} />
          <span className="vc2-count plan-end">{filtered.length} of {decorated.length} vendors</span>
          <button type="button" className="vc2-btn" onClick={exportRows}><Download size={14} /> Export</button>
        </div>
        <div className="table-scroll">
          <table className="vc2-table">
            <thead>
              <tr>
                <th {...sort.th('vendor', (d) => d.vendor.vendor_name || d.vendor.vendor_code)}>Vendor {sort.ind('vendor')}</th>
                <th className="num" {...sort.th('machines', (d) => (d.m.entered ? num(d.effective.machines_allocated) : null))}>Machines {sort.ind('machines')}</th>
                <th className="num" {...sort.th('karigar', (d) => (d.m.entered ? num(d.effective.active_karigar) : null))}>Karigars {sort.ind('karigar')}</th>
                <th className="num" {...sort.th('cap', (d) => (d.m.entered ? d.m.capacityPerMonth : null))}>Capacity / month {sort.ind('cap')}</th>
                <th className="num" {...sort.th('po', (d) => (d.m.entered ? d.m.poCapacity : null))}>PO capacity {sort.ind('po')}</th>
                <th className="num" {...sort.th('onorder', (d) => d.vendor.inProcessQty)}>On order {sort.ind('onorder')}</th>
                <th className="num" {...sort.th('avail', (d) => d.m.available)}>Available {sort.ind('avail')}</th>
                <th {...sort.th('util', (d) => d.m.capacityUtil)}>Capacity used {sort.ind('util')}</th>
                <th className="num" {...sort.th('mutil', (d) => d.m.machineUtil)}>Machine util {sort.ind('mutil')}</th>
                <th {...sort.th('updated', (d) => d.lastUpdated ?? '')}>{live ? 'Status' : 'Last updated'} {sort.ind('updated')}</th>
              </tr>
            </thead>
            <tbody>
              {sort.apply(filtered).map((d) => {
                const { vendor, m } = d;
                const type = typeConfig(vendor.vendor_type)?.label ?? (vendor.vendor_type || '—');
                const util = m.capacityUtil ?? 0;
                // A blank row is still running on last week's numbers: say so quietly.
                const fromLast = live && !d.thisWeek && !d.dirty;
                const status = !live ? (
                  <div className="vc2-upd">
                    <span>{dayLabel(d.lastUpdated)}</span>
                    {d.isStale && <span className="vc2-badge warn">Stale</span>}
                  </div>
                ) : errors[d.code] ? (
                  <span className="vc2-badge crit" title={errors[d.code]}>Not saved</span>
                ) : d.dirty ? (
                  <span className="vc2-badge info">Edited</span>
                ) : d.thisWeek ? (
                  <span className="vc2-badge ok" title={`Saved ${dayLabel(d.lastUpdated)}`}><i />Updated this week</span>
                ) : (
                  <span className="vc2-badge warn" title={`Last saved ${dayLabel(d.lastUpdated)}`}>Due this week</span>
                );
                const inputCell = (field: InputField) =>
                  editable ? (
                    <td key={field} className="num">
                      <input
                        className={`vc2-inp${d.dirty && d.shown[field] !== '' ? ' is-dirty' : ''}`}
                        inputMode="numeric"
                        value={d.shown[field]}
                        disabled={saving}
                        aria-label={`${field === 'machines_allocated' ? 'Machines' : 'Karigars'} for ${vendor.vendor_name || vendor.vendor_code}`}
                        title={!d.thisWeek && d.last[field] ? `Last saved ${d.last[field]} on ${dayLabel(d.lastUpdated)} (still used in calculations)` : undefined}
                        onChange={(e) => setField(d.code, field, e.target.value)}
                      />
                      {!d.thisWeek && d.last[field] !== '' && <span className="vc2-last">last {d.last[field]}</span>}
                    </td>
                  ) : (
                    <td key={field} className="num">{m.entered ? fmt.format(num(d.effective[field])) : ''}</td>
                  );
                return (
                  <tr key={vendor.vendor_code} className={!m.entered ? 'is-empty' : m.over ? 'is-over' : undefined}>
                    <td>
                      <div className="vc2-vendor">
                        <strong title={vendor.machinesAtOnboarding ? `${vendor.machinesAtOnboarding} machines at onboarding` : undefined}>{vendor.vendor_name || vendor.vendor_code}</strong>
                        <span><code>{vendor.vendor_code}</code>{vendor.merchant ? ` · ${vendor.merchant}` : ''} · {type} · {m.leadDays} d lead</span>
                      </div>
                      <DeboardedPill flag={vendor.deboarded} />
                    </td>
                    {!m.entered && !editable ? (
                      <td colSpan={8} className="vc2-none">
                        {d.lastUpdated ? 'Saved with no machines or karigars' : asOf ? 'Nothing entered by the end of this week' : 'Nothing entered yet'}
                        {vendor.inProcessQty ? ` · ${fmt.format(vendor.inProcessQty)} pcs on order` : ''}
                      </td>
                    ) : !m.entered ? (
                      <>
                        {INPUT_FIELDS.map(inputCell)}
                        <td colSpan={6} className="vc2-none">
                          No karigars on record yet{vendor.inProcessQty ? ` · ${fmt.format(vendor.inProcessQty)} pcs on order` : ''}
                        </td>
                      </>
                    ) : (
                      <>
                        {INPUT_FIELDS.map(inputCell)}
                        <td className={`num strong${fromLast ? ' vc2-from-last' : ''}`}>{fmt.format(m.capacityPerMonth)}</td>
                        <td className={`num${fromLast ? ' vc2-from-last' : ''}`} title={`capacity/day ${fmt.format(m.capacityPerDay)} × ${m.leadDays} lead days × ${rules.workingDays}/30`}>{fmt.format(m.poCapacity)}</td>
                        <td className="num">{fmt.format(vendor.inProcessQty)}</td>
                        <td className="num">{m.over ? <span className="vc-over-text">Over</span> : fmt.format(m.available ?? 0)}</td>
                        <td>
                          <div className={`vc2-util${m.over ? ' is-over' : ''}`}>
                            <span>{m.over ? OVER_UTILISED : utilisationLabel(m.capacityUtil)}</span>
                            <span className="vc2-bar"><i className={m.over ? 'crit' : util >= 80 ? 'warn' : undefined} style={{ width: `${Math.min(100, Math.max(0, util))}%` }} /></span>
                          </div>
                        </td>
                        <td className="num">{m.machineUtil == null ? '—' : `${m.machineUtil}%`}</td>
                      </>
                    )}
                    <td>{status}</td>
                  </tr>
                );
              })}
              {!filtered.length && (
                <tr>
                  <td colSpan={colCount} className="vc2-none vc2-empty">No vendors match these filters.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="vc2-foot">
          <span>{asOf ? 'View only. Open the current week to change figures.' : 'Grey Capacity / PO capacity figures come from the vendor’s last saved update.'}</span>
          <span>Capacity / month = karigars × {rules.dailyOutput} pcs × {rules.workingDays} days · PO capacity = capacity / month × lead days ÷ 30</span>
        </div>
      </section>

      {editable && dirtyRows.length > 0 && (
        <div className="vc2-savebar" role="region" aria-label="Unsaved changes">
          <span>{dirtyRows.length} vendor{dirtyRows.length === 1 ? '' : 's'} changed</span>
          <span className="vc2-savebar-actions">
            <button type="button" className="vc2-btn vc2-btn-ghost" disabled={saving} onClick={() => { setEdits({}); setErrors({}); }}>Discard</button>
            <button type="button" className="vc2-btn vc2-btn-save" disabled={saving} onClick={saveAll}>{saving ? 'Saving…' : 'Save'}</button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ------------------------- Entry tab: the running week ------------------------- */
// The editable sheet for the current week, as it was before the past-week redesign
// (the user wants the new look on past weeks only). Past weeks use EntryTab below.

function LiveEntryTab({
  vendors,
  asOf = null,
  role,
  initialSearch,
  allocations = [],
  catalog = [],
  rules = DEFAULT_CAPACITY_RULES,
}: {
  vendors: Vendor[];
  asOf?: { week: string; label: string; inProcessKept: boolean } | null;
  role: SdRole;
  initialSearch?: string;
  /** Product allocations, so the sheet can be narrowed to who makes a given product. */
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  rules?: CapacityRules;
}) {
  // A past week is a record of what was entered then: nothing to type.
  const editable = !asOf && canEdit(role, 'draft');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [staleOnly, setStaleOnly] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [vType, setVType] = useState('');
  // Third filter alongside merchandiser and type: which vendors are committed to a product.
  const [product, setProduct] = useState('');
  // Clear all filters: search (even one opened from a vendor link), every select and Stale only.
  const filtersActive = search !== '' || staleOnly || merchant !== '' || vType !== '' || product !== '';
  const clearFilters = () => {
    setSearch('');
    setStaleOnly(false);
    setMerchant('');
    setVType('');
    setProduct('');
  };
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // Client-only "now", set once after mount so the server render never disagrees
    // on staleness (hydration-safe) — an intentional set-in-effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now());
  }, []);

  const merchants = useMemo(
    () => [...new Set(vendors.map((v) => v.merchant.trim()).filter(Boolean))].sort(),
    [vendors],
  );
  /** Vendors carrying an allocation for the chosen product code. */
  const vendorsForProduct = useMemo(() => {
    if (!product) return null;
    const want = product.trim().toUpperCase();
    return new Set(
      allocations
        .filter((a) => (a.product_code ?? '').trim().toUpperCase() === want)
        .map((a) => (a.vendor_code ?? '').trim().toUpperCase()),
    );
  }, [allocations, product]);
  const allocatedProducts = useMemo(
    () =>
      [...new Set(allocations.map((a) => (a.product_code ?? '').trim()).filter(Boolean))].sort(),
    [allocations],
  );

  const vTypes = useMemo(
    () => [...new Set(vendors.map((v) => v.vendor_type.trim()).filter(Boolean))].sort(),
    [vendors],
  );

  // Staleness is judged at the end of the week shown (a past week) or right now.
  const ref = asOf ? Date.parse(`${capacityWeekNext(new Date(`${asOf.week}T12:00:00+05:30`))}T00:00:00+05:30`) : now;
  const decorated = useMemo(
    () =>
      vendors.map((vendor) => {
        const lastUpdated = vendor.current?.entry_date ?? null;
        const isStale =
          ref != null && (!lastUpdated || ref - new Date(lastUpdated).getTime() > STALE_MS);
        return { vendor, lastUpdated, isStale };
      }),
    [vendors, ref],
  );

  // On this sheet a vendor counts once entered this week; until then its machines / karigars
  // are blank here, so it adds nothing to the tiles (other pages keep the last saved figures).
  const weekStartMs = Date.parse(`${capacityWeekStart()}T00:00:00+05:30`);
  const modelThisWeek = (vendor: Vendor) =>
    vendor.current?.entry_date && Date.parse(vendor.current.entry_date) >= weekStartMs
      ? modelOf(vendor, rules)
      : vendorCapacityModel({ machines: 0, karigar: 0, vendorType: vendor.vendor_type, inProcessQty: vendor.inProcessQty }, rules);
  const overCount = decorated.filter(({ vendor }) => modelThisWeek(vendor).over).length;
  const staleCount = decorated.filter((d) => d.isStale).length;
  // Section 8 of the spec: the formulas are pointless while the data is a month old.
  const oldestUpdate = decorated.reduce<number | null>((m, d) => {
    const t = d.lastUpdated ? new Date(d.lastUpdated).getTime() : null;
    return t == null ? m : m == null ? t : Math.max(m, t);
  }, null);
  const weekStart = capacityWeekStart();

  const q = search.trim().toLowerCase();
  const filtered = decorated
    .filter(({ vendor }) =>
      q ? `${vendor.vendor_code} ${vendor.vendor_name}`.toLowerCase().includes(q) : true,
    )
    .filter(({ vendor }) => (merchant ? vendor.merchant.trim() === merchant : true))
    .filter(({ vendor }) => (vType ? vendor.vendor_type.trim() === vType : true))
    .filter(({ vendor }) =>
      vendorsForProduct ? vendorsForProduct.has(vendor.vendor_code.trim().toUpperCase()) : true,
    )
    .filter((d) => (staleOnly ? d.isStale : true))
    .sort((a, b) => {
      const at = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      const bt = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return at - bt;
    });
  const sort = useColumnSort<(typeof filtered)[number]>();
  // Totals count only vendors with a capacity entry; "Not entered" is not zero capacity.
  const visibleModels = filtered.map(({ vendor }) => ({ vendor, m: modelThisWeek(vendor) }));
  const entered = visibleModels.filter((x) => x.m.entered);
  const visiblePoCapacity = entered.reduce((t, x) => t + x.m.poCapacity, 0);
  const visibleMonthly = entered.reduce((t, x) => t + x.m.capacityPerMonth, 0);
  const visibleInProcess = entered.reduce((t, x) => t + x.vendor.inProcessQty, 0);
  const visibleOver = entered.filter((x) => x.m.over).length;
  const visibleNotEntered = visibleModels.length - entered.length;
  const visibleStale = filtered.filter(({ isStale }) => isStale).length;

  function exportRows() {
    downloadCsv('vendor-capacity-entry.csv', [
      ['Vendor code', 'Vendor', 'Merchandiser', 'Type', 'Machines allocated', 'Karigar allocated', 'Capacity/month', 'First machines', 'PO capacity', 'In process', 'Available', 'Machine util %', 'Capacity util %', 'Last updated'],
      ...sort.apply(filtered).map(({ vendor, lastUpdated }) => {
        const m = modelThisWeek(vendor);
        // Same as the screen: a vendor not entered this week has blank figures.
        const thisWeek = lastUpdated != null && Date.parse(lastUpdated) >= weekStartMs;
        const machines = thisWeek ? Number(vendor.current?.machines_allocated ?? 0) : '';
        const karigar = thisWeek ? Number(vendor.current?.active_karigar ?? 0) : '';
        return m.entered
          ? [vendor.vendor_code, vendor.vendor_name, vendor.merchant, vendor.vendor_type, machines, karigar, m.capacityPerMonth, vendor.machinesAtOnboarding, m.poCapacity, vendor.inProcessQty, m.available, m.machineUtil, utilisationLabel(m.capacityUtil), lastUpdated]
          : [vendor.vendor_code, vendor.vendor_name, vendor.merchant, vendor.vendor_type, machines, karigar, '', vendor.machinesAtOnboarding, '', vendor.inProcessQty, '', '', '', lastUpdated];
      }),
    ]);
  }

  return (
    <div className="vc-section">
      <div className="vc-metrics">
        <CapacityMetric
          label="PO capacity"
          value={fmt.format(visiblePoCapacity)}
          detail={`${entered.length} vendors entered this week · ${fmt.format(visibleMonthly)} pcs/month capacity${visibleNotEntered ? ` · ${visibleNotEntered} not entered yet` : ''}`}
        />
        <CapacityMetric
          label="On order (in process)"
          value={fmt.format(visibleInProcess)}
          detail={visiblePoCapacity ? `${Math.round((visibleInProcess / visiblePoCapacity) * 1000) / 10}% of PO capacity` : 'pcs in production'}
          tone="blue"
        />
        <CapacityMetric label="Over PO capacity" value={String(visibleOver)} detail="vendors with more on order than their PO capacity" tone="red" />
        <CapacityMetric label="Stale updates" value={String(visibleStale)} detail={`older than ${STALE_DAYS} days`} tone="amber" />
      </div>
      {asOf && (
        <Notice tone="info">
          <strong>Week {asOf.label}.</strong>{' '}Machines, karigars, capacity and Last updated are each
          vendor&apos;s figures as entered by the end of this week (its last update on or before that
          Sunday); a vendor with nothing entered by then reads Not entered.{' '}
          {asOf.inProcessKept
            ? 'On order (in process), Available and Capacity util use what was on order at the end of this week.'
            : 'On order (in process), Available and Capacity util use today’s open POs: the weekly in-process copy started after this week.'}{' '}
          Read-only: to change figures, open the current week.
        </Notice>
      )}
      {!asOf && staleCount > 0 && staleCount >= Math.max(1, Math.round(decorated.length * 0.5)) && (
        <Notice tone="warn">
          <strong>{staleCount} of {decorated.length} vendors have not been updated in over {STALE_DAYS} days</strong>
          {oldestUpdate ? ` — the most recent entry anywhere is ${new Date(oldestUpdate).toLocaleDateString('en-IN')}` : ''}.
          Every capacity, availability and utilisation figure on this page is only as current
          as that. Get this week&apos;s submission from each merchandiser before these numbers are
          presented. This week runs Monday {new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })} to Sunday; a vendor can be updated on any day of it.
        </Notice>
      )}

      <div className="wf-toolbar vc-toolbar">
        <div className="wf-toolbar-left plan-filterbar">
          <Field label="Search vendor">
            <input
              value={search}
              placeholder="Search vendor name or code"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
          <select className="meta-select" value={merchant} onChange={(e) => setMerchant(e.target.value)}>
            <option value="">All merchandisers</option>
            {merchants.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <select className="meta-select" value={vType} onChange={(e) => setVType(e.target.value)}>
            <option value="">All vendor types</option>
            {vTypes.map((t) => (
              <option key={t} value={t}>
                {typeConfig(t)?.label ?? t}
              </option>
            ))}
          </select>
          <select
            className="meta-select"
            aria-label="Filter by product"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
          >
            <option value="">Product: All</option>
            {allocatedProducts.map((code) => (
              <option key={code} value={code}>
                {code}
                {catalog.find((c) => c.product_code === code)?.product_name
                  ? ` · ${catalog.find((c) => c.product_code === code)?.product_name}`
                  : ''}
              </option>
            ))}
          </select>
          <label className="wf-check-field">
            <input
              type="checkbox"
              checked={staleOnly}
              onChange={(event) => setStaleOnly(event.target.checked)}
            />
            Stale only ({staleCount})
          </label>
          <ClearFiltersButton active={filtersActive} onClear={clearFilters} />
        </div>
        <div className="wf-toolbar-right">
          <span className="vc-result-count">{filtered.length} of {decorated.length} shown</span>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm vc-export" onClick={exportRows}>
            <Download size={13} /> Download CSV
          </button>
          <span className="wf-chip">
            {decorated.length} vendors
            {staleCount > 0 && (
              <em className="wf-chip-warn">
                <Clock size={13} /> {staleCount} stale
              </em>
            )}
            {overCount > 0 && (
              <em className="wf-chip-warn">
                <AlertTriangle size={13} /> {overCount} over PO capacity
              </em>
            )}
          </span>
        </div>
      </div>

      {!asOf && (
      <Notice tone="info">
        Only <strong>two fields are ever typed</strong>:{' '}
        <span className="wf-live-tag">LIVE</span> Machines allocated and Karigar allocated.
        Everything in an <span className="wf-computed-tag">orange</span> cell is computed by one
        formula (Rules Master): capacity/day = {rules.driverMinMachines ? 'min(machines, karigars)' : 'karigars'} × {rules.dailyOutput} pieces;
        <strong> Capacity/month</strong> = capacity/day × {rules.workingDays} working days;
        <strong> PO capacity</strong> = what the vendor can make inside its PO type&apos;s lead time
        (Job Work {rules.leadDays.job_work}d · E-FOB {rules.leadDays.efob}d · FOB {rules.leadDays.fob}d), i.e.
        capacity/month × lead days ÷ 30. <strong>Available</strong> = PO capacity − on order;
        <strong> Capacity util</strong> = on order ÷ PO capacity, reading "100% Over Utilised"
        once past capacity. A vendor with nothing entered reads <strong>Not entered</strong> and is
        left out of every total. First machines and Type are{' '}
        <span className="wf-fixed-tag">
          <Lock size={10} /> FIXED
        </span>{' '}
        from the vendor master. A vendor not updated in over {STALE_DAYS} days is flagged{' '}
        <strong>stale</strong>.
      </Notice>
      )}

      {asOf ? (
        <div className="table-panel vc-table-card vc-snap-card">
          <div className="vc-card-head">
            <div><h2>Capacity · week {asOf.label}</h2><p>What each vendor had entered by the end of this week.</p></div>
            <span className="vc-pill">Past week · view only</span>
          </div>
          <div className="table-scroll">
            <table className="vc-snap">
              <thead>
                <tr>
                  <th {...sort.th('vendor', (d) => d.vendor.vendor_name || d.vendor.vendor_code)}>Vendor {sort.ind('vendor')}</th>
                  <th className="num" {...sort.th('machines', (d) => d.vendor.current?.machines_allocated ?? null)}>Machines {sort.ind('machines')}</th>
                  <th className="num" {...sort.th('karigar', (d) => d.vendor.current?.active_karigar ?? null)}>Karigars {sort.ind('karigar')}</th>
                  <th className="num" {...sort.th('cap', (d) => modelOf(d.vendor, rules).capacityPerMonth || null)}>Capacity / month {sort.ind('cap')}</th>
                  <th className="num" {...sort.th('po', (d) => modelOf(d.vendor, rules).poCapacity || null)}>PO capacity {sort.ind('po')}</th>
                  <th className="num" {...sort.th('onorder', (d) => d.vendor.inProcessQty)}>On order {sort.ind('onorder')}</th>
                  <th className="num">Available</th>
                  <th {...sort.th('util', (d) => modelOf(d.vendor, rules).capacityUtil)}>Capacity used {sort.ind('util')}</th>
                  <th className="num">Machine util</th>
                  <th {...sort.th('updated', (d) => d.lastUpdated ?? '')}>Last updated {sort.ind('updated')}</th>
                </tr>
              </thead>
              <tbody>
                {sort.apply(filtered).map(({ vendor, lastUpdated, isStale }) => {
                  const m = modelOf(vendor, rules);
                  const type = typeConfig(vendor.vendor_type)?.label ?? (vendor.vendor_type || '—');
                  const util = m.capacityUtil ?? 0;
                  return (
                    <tr key={vendor.vendor_code} className={!m.entered ? 'is-empty' : m.over ? 'is-over' : undefined}>
                      <td>
                        <div className="vc-snap-vendor">
                          <strong>{vendor.vendor_name || vendor.vendor_code}</strong>
                          <span>{vendor.vendor_code}{vendor.merchant ? ` · ${vendor.merchant}` : ''} · {type} · {m.leadDays}d lead</span>
                        </div>
                        <DeboardedPill flag={vendor.deboarded} />
                      </td>
                      {m.entered ? (
                        <>
                          <td className="num">{fmt.format(Number(vendor.current?.machines_allocated ?? 0))}</td>
                          <td className="num">{fmt.format(Number(vendor.current?.active_karigar ?? 0))}</td>
                          <td className="num strong">{fmt.format(m.capacityPerMonth)}</td>
                          <td className="num">{fmt.format(m.poCapacity)}</td>
                          <td className="num">{fmt.format(vendor.inProcessQty)}</td>
                          <td className="num">{m.over ? <span className="vc-over-text">Over</span> : fmt.format(m.available ?? 0)}</td>
                          <td>
                            <div className="vc-snap-util">
                              <span className={m.over ? 'vc-util-over' : undefined}>{utilisationLabel(m.capacityUtil)}</span>
                              <span className="vc-progress">
                                <span className={m.over ? 'vc-progress-over' : util >= 80 ? 'vc-progress-warn' : undefined} style={{ width: `${Math.min(100, Math.max(0, util))}%` }} />
                              </span>
                            </div>
                          </td>
                          <td className="num">{m.machineUtil == null ? '—' : `${m.machineUtil}%`}</td>
                        </>
                      ) : (
                        <td colSpan={8} className="vc-snap-none">{lastUpdated ? 'Saved with no machines or karigars' : 'Nothing entered by the end of this week'}{vendor.inProcessQty ? ` · ${fmt.format(vendor.inProcessQty)} pcs on order` : ''}</td>
                      )}
                      <td>
                        <div className="vc-snap-date">
                          <span>{lastUpdated ? new Date(lastUpdated).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never'}</span>
                          {isStale && <span className="vc-pill vc-pill-amber">Stale</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!filtered.length && (
                  <tr>
                    <td colSpan={10} className="vc-snap-none">{staleOnly ? 'No stale vendors in this week.' : 'No vendors match your filters.'}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
      <div className="table-panel wf-grid-panel vc-table-card">
        <div className="vc-card-head">
          <div><h2>Capacity worklist</h2><p>Enter machines and karigar for a vendor and save that row. Any day of the week; the board counts each vendor&apos;s latest update in the week (Monday to Sunday). Each Monday the boxes start blank, and so do the figures worked out from them, until the vendor is entered. Other pages keep using the last saved numbers meanwhile (hover a blank box to see them).</p></div>
          <span className="vc-pill vc-pill-blue">Weekly update · any day</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th {...sort.th('vendor', (d) => d.vendor.vendor_name || d.vendor.vendor_code)}>Vendor {sort.ind('vendor')} <HeaderInfo label="Vendor" /></th>
                <th {...sort.th('type', (d) => d.vendor.vendor_type)}>
                  Type <span className="wf-fixed-tag"><Lock size={9} /></span> {sort.ind('type')}
                 <HeaderInfo label="Type" /></th>
                <th className="num input-col" {...sort.th('machines', (d) => d.vendor.current?.machines_allocated ?? null)}>
                  Machines allocated <span className="wf-live-tag">LIVE</span> {sort.ind('machines')}
                 <HeaderInfo label="Machines allocated LIVE" /></th>
                <th className="num input-col" {...sort.th('karigar', (d) => d.vendor.current?.active_karigar ?? null)}>
                  Karigar allocated <span className="wf-live-tag">LIVE</span> {sort.ind('karigar')}
                 <HeaderInfo label="Karigar allocated LIVE" /></th>
                <th className="num">Capacity / month <HeaderInfo label="Capacity / month" /></th>
                <th className="num">PO capacity <HeaderInfo label="PO capacity" /></th>
                <th className="num">
                  First machines <span className="wf-fixed-tag"><Lock size={9} /></span>
                 <HeaderInfo label="First machines" /></th>
                <th className="num">On order (in process) <HeaderInfo label="On order (in process)" /></th>
                <th className="num">Available <HeaderInfo label="Available" /></th>
                <th className="num">Machine util <HeaderInfo label="Machine util" /></th>
                <th className="num">Capacity util <HeaderInfo label="Capacity util" /></th>
                <th {...sort.th('updated', (d) => d.lastUpdated ?? '')}>Last updated {sort.ind('updated')} <HeaderInfo label="Last updated" /></th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {sort.apply(filtered).map(({ vendor, lastUpdated, isStale }) => (
                <CapacityRow
                  key={vendor.vendor_code}
                  vendor={vendor}
                  editable={editable}
                  lastUpdated={lastUpdated}
                  isStale={isStale}
                  now={asOf ? null : now}
                  rules={rules}
                  isAdmin={role === 'admin'}
                />
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={editable ? 13 : 12} className="wf-empty-cell">
                    {staleOnly
                      ? 'No stale vendors — everyone is up to date.'
                      : 'No vendors match your filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      <div className="wf-footer-bar">
        <p className="wf-footer-note">
          Capacity/month = Karigars × pieces per karigar per day × working days a month
          (Job ×1.0 · E-FOB ×1.5 · FOB ×2.5 · E-FOB/FOB ×2.0). Available = PO capacity −
          in-process (negative = 100% and over Utilised). Machine util = Karigar ÷ Machines; Capacity
          util = In-process ÷ PO capacity.
        </p>
      </div>
    </div>
  );
}

function CapacityRow({
  vendor,
  editable,
  lastUpdated,
  isStale,
  now,
  rules = DEFAULT_CAPACITY_RULES,
  isAdmin = false,
}: {
  vendor: Vendor;
  editable: boolean;
  lastUpdated: string | null;
  isStale: boolean;
  now: number | null;
  rules?: CapacityRules;
  /** An admin can correct a locked row; the team waits for Monday. */
  isAdmin?: boolean;
}) {
  // The vendor's last saved figures. Every calculation (here and on every other page) keeps
  // using them until a new update is saved.
  const last = {
    machines_allocated: vendor.current?.machines_allocated?.toString() ?? '',
    active_karigar: vendor.current?.active_karigar?.toString() ?? '',
  };
  // A new week starts blank: the inputs show only what was entered this week (Monday to Sunday),
  // so a vendor not yet updated reads as not entered yet.
  const enteredThisWeek =
    lastUpdated != null && Date.parse(lastUpdated) >= Date.parse(`${capacityWeekStart()}T00:00:00+05:30`);
  const initial = enteredThisWeek ? last : { machines_allocated: '', active_karigar: '' };
  const [fields, setFields] = useState(initial);
  const [saved, setSaved] = useState<string | null>(lastUpdated);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty =
    fields.machines_allocated !== initial.machines_allocated ||
    fields.active_karigar !== initial.active_karigar;

  const config = typeConfig(vendor.vendor_type);
  // What counts: a typed figure, else the last saved one (a blank field is not zero).
  const effective = {
    machines_allocated: fields.machines_allocated !== '' ? fields.machines_allocated : last.machines_allocated,
    active_karigar: fields.active_karigar !== '' ? fields.active_karigar : last.active_karigar,
  };
  const machines = num(effective.machines_allocated);
  const karigar = num(effective.active_karigar);
  // One model for every figure on the row — the same function Reporting, Vendor Performance
  // and PO Approval use — fed from what is typed now, or the last saved figures.
  const model = vendorCapacityModel(
    { machines, karigar, vendorType: vendor.vendor_type, inProcessQty: vendor.inProcessQty },
    rules,
  );
  const inProcess = vendor.inProcessQty;
  // Nothing entered this week yet: every figure built on machines / karigars stays blank on this
  // sheet (other pages keep using the last saved figures). Typing brings them back.
  const showFigures = enteredThisWeek || dirty;
  // Submitted inside the current capacity week → locked until Monday (admins can correct).
  const locked = capacityLocked(saved) && !dirty;
  const canType = editable && (!locked || isAdmin);

  function set(field: keyof typeof fields, value: string) {
    setFields((cur) => ({ ...cur, [field]: value }));
  }

  function save() {
    setError(null);
    const payload = new FormData();
    payload.set('vendor_code', vendor.vendor_code);
    payload.set('vendor_name', vendor.vendor_name);
    payload.set('machines_allocated', effective.machines_allocated);
    payload.set('active_karigar', effective.active_karigar);
    payload.set('capacity_per_month', String(model.capacityPerMonth || ''));
    start(async () => {
      const result = await saveVendorCapacityRow(payload);
      if (result.ok) setSaved(new Date().toISOString());
      else setError(toastError(result.error));
    });
  }

  return (
    <tr className={showFigures && model.over ? 'wf-row-over' : isStale ? 'wf-row-stale' : ''}>
      <td className="vc-vendor-cell">
        <strong>{vendor.vendor_name || vendor.vendor_code}</strong>
        <small className="mono wf-subtle">{vendor.vendor_code}{vendor.merchant ? ` · ${vendor.merchant}` : ''}</small>
        <DeboardedPill flag={vendor.deboarded} />
      </td>
      <td>
        <span className="vc-pill">{config?.label ?? (vendor.vendor_type || '—')}</span>
        <small className="wf-subtle">lead {model.leadDays}d</small>
      </td>
      {(['machines_allocated', 'active_karigar'] as const).map((field) => (
        <td key={field} className="num input-col">
          <input
            type="number"
            min={0}
            value={fields[field]}
            title={!enteredThisWeek && last[field] ? `Not entered this week. Last saved: ${last[field]}${lastUpdated ? ` on ${new Date(lastUpdated).toLocaleDateString('en-IN')}` : ''} (still used in calculations)` : undefined}
            disabled={!canType}
            aria-label={`${field === 'machines_allocated' ? 'Machines allocated' : 'Karigar allocated'} for ${vendor.vendor_name || vendor.vendor_code}`}
            onChange={(event) => set(field, event.target.value)}
          />
        </td>
      ))}
      {!showFigures ? (
        <>
          <td className="num wf-computed" />
          <td className="num wf-computed" />
        </>
      ) : model.entered ? (
        <>
          <td className="num wf-computed">{fmt.format(model.capacityPerMonth)}</td>
          <td className="num wf-computed" title={`capacity/day ${fmt.format(model.capacityPerDay)} × ${model.leadDays} lead days × ${rules.workingDays}/30`}>
            {fmt.format(model.poCapacity)}
          </td>
        </>
      ) : (
        <>
          <td className="num"><span className="wf-subtle">Not entered</span></td>
          <td className="num"><span className="wf-subtle">Not entered</span></td>
        </>
      )}
      <td className="num wf-fixed-value">
        {vendor.machinesAtOnboarding ? fmt.format(vendor.machinesAtOnboarding) : '—'}
      </td>
      <td className="num">{fmt.format(inProcess)}</td>
      {/* Past capacity the headroom is negative and only says how far past; the state is the
          thing to read — the utilisation cell beside it reads "100% Over Utilised". */}
      <td className="num wf-computed strong">
        {!showFigures ? null : !model.entered ? (
          <span className="wf-subtle">—</span>
        ) : model.over ? (
          <span className="vc-over-text">Over Utilised</span>
        ) : (
          fmt.format(model.available ?? 0)
        )}
      </td>
      <td className="num wf-computed">{!showFigures ? null : model.machineUtil == null ? '—' : `${model.machineUtil}%`}</td>
      {/* Past 100% the cell states the condition, not the figure — see src/lib/utilisation.ts. */}
      <td className={`num wf-computed${showFigures && model.over ? ' vc-util-over' : ''}`}>
        {showFigures ? utilisationLabel(model.capacityUtil) : null}
      </td>
      <td className="wf-subtle">
        {ageLabel(saved, now)}
        {locked && (
          <span className="vc-pill vc-pill-green" title={`Submitted this week; reopens Monday ${new Date(`${capacityWeekNext()}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`}>
            <Lock size={9} /> Submitted · locked
          </span>
        )}
        {isStale && !dirty && !locked && <span className="vc-pill vc-pill-amber">Stale</span>}
        {error && <small className="wf-error-text">{error}</small>}
      </td>
      {editable && (
        <td>
          {locked && !isAdmin ? (
            <span className="wf-subtle">Opens Mon</span>
          ) : (
            <button
              type="button"
              className="wf-btn wf-btn-primary wf-btn-sm"
              onClick={save}
              disabled={pending || !dirty}
              title={locked ? 'Admin correction to a submitted week' : 'Save this vendor’s figures (any day of the week)'}
            >
              <Save size={14} /> {pending ? 'Saving…' : locked ? 'Correct' : 'Save update'}
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

/* --------------------- Product Allocation tab (item 1) --------------------- */

function ProductAllocationTab({
  vendors,
  allocations,
  catalog,
  role,
  initialVendor,
}: {
  vendors: Vendor[];
  allocations: VendorProductAllocation[];
  catalog: ProductCatalogItem[];
  role: SdRole;
  initialVendor?: string;
}) {
  const editable = canEdit(role, 'draft');
  const [vendorCode, setVendorCode] = useState(initialVendor || vendors[0]?.vendor_code || '');
  const vendor = vendors.find((v) => v.vendor_code === vendorCode) ?? null;

  const rows = useMemo(
    () => allocations.filter((a) => a.vendor_code === vendorCode),
    [allocations, vendorCode],
  );
  const allocated = rows.reduce((s, r) => s + (Number(r.allocated_qty) || 0), 0);
  // Bound: the vendor's signed monthly capacity, else the live machines×karigar figure.
  const liveCap = vendor
    ? Number(vendor.current?.machines_allocated ?? 0) * Number(vendor.current?.active_karigar ?? 0)
    : 0;
  const capacity = vendor?.capacitySigned || liveCap;
  const over = capacity > 0 && allocated > capacity;
  const existingCodes = useMemo(() => new Set(rows.map((r) => r.product_code)), [rows]);
  const [newCode, setNewCode] = useState<string | null>(null);

  function exportRows() {
    if (!vendor) return;
    downloadCsv(`vendor-allocation-${vendor.vendor_code}.csv`, [
      ['Vendor code', 'Vendor', 'Product code', 'Product', 'Allocated pcs/month', 'Last set'],
      ...rows.map((row) => [vendor.vendor_code, vendor.vendor_name, row.product_code, catalog.find((item) => item.product_code === row.product_code)?.product_name ?? '', row.allocated_qty, row.entry_date]),
    ]);
  }

  return (
    <div className="vc-section">
      <Notice tone={over ? 'warn' : 'info'}>
        Allocate how many pieces/month of each product this vendor is committed to — absolute
        pieces, not a percentage. The total is checked against the vendor&rsquo;s monthly capacity
        ({capacity ? fmt.format(capacity) : 'not set'}); going over is <strong>warned, not blocked</strong>.
      </Notice>
      <div className="vc-allocation-layout">
        <section className="vc-card vc-allocation-card">
          <div className="vc-card-head">
            <div><h2>Product allocation</h2><p>Monthly product commitments for the selected vendor</p></div>
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm vc-export" onClick={exportRows} disabled={!vendor}>
              <Download size={13} /> Download CSV
            </button>
          </div>
          <div className="vc-allocation-overview">
            <Field label="Vendor">
              <select className="meta-select" value={vendorCode} onChange={(e) => setVendorCode(e.target.value)}>
                {vendors.map((v) => (
                  <option key={v.vendor_code} value={v.vendor_code}>
                    {v.vendor_name} ({v.vendor_code})
                  </option>
                ))}
              </select>
            </Field>
            <div className="vc-summary-grid">
              <div><span>Monthly capacity</span><strong>{capacity ? fmt.format(capacity) : '—'}</strong></div>
              <div><span>Total allocated</span><strong>{fmt.format(allocated)}</strong></div>
              <div><span>Remaining</span><strong className={capacity && allocated > capacity ? 'vc-negative' : ''}>{capacity ? fmt.format(capacity - allocated) : '—'}</strong></div>
            </div>
            <div className="vc-usage-label"><span>Allocated against monthly capacity</span><strong>{capacity ? `${Math.round(allocated / capacity * 100)}%` : 'Capacity not set'}</strong></div>
            <CapacityBar value={capacity ? Math.round(allocated / capacity * 100) : null} />
            {over && <span className="vc-allocation-warning"><AlertTriangle size={13} /> Allocation exceeds monthly capacity; saving is still allowed.</span>}
          </div>
          <div className="table-scroll">
            <table className="wide-table wf-grid vc-allocation-table">
              <thead><tr><th>Product <HeaderInfo label="Product" /></th><th className="num input-col">Allocated (pcs/month) <HeaderInfo label="Allocated (pcs/month)" /></th><th>Last set <HeaderInfo label="Last set" /></th>{editable && <th aria-label="Actions" />}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <AllocationRow key={r.id} row={r} editable={editable} productName={catalog.find((item) => item.product_code === r.product_code)?.product_name ?? null} />
                ))}
                {!rows.length && <tr><td colSpan={editable ? 4 : 3} className="wf-empty-cell">No product allocations for this vendor yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="vc-allocation-side">
          {editable && vendor && (
            <section className="vc-card vc-add-card">
              <div className="vc-card-head"><div><h2>Add a product</h2><p>Choose a Product Master item or enter a new code</p></div></div>
              <div className="vc-card-body">
                <Field label="Product" hint="search by code or name">
                  <ProductPicker items={catalog} exclude={existingCodes} onPick={(code) => setNewCode(code)} allowFreeText={false} placeholder="Search product code or name…" />
                </Field>
                {newCode && <AllocationEditor key={newCode} vendorCode={vendorCode} productCode={newCode} initialQty="" isNew />}
              </div>
            </section>
          )}
          <section className="vc-card vc-guidance-card">
            <div className="vc-card-head"><h2>Capacity check</h2></div>
            <div className="vc-card-body"><p>The comparison uses this vendor&apos;s signed monthly capacity, or the current machines × karigar value when signed capacity is unavailable.</p><p>Product quantities are saved individually. Going over capacity is a warning, not a block.</p></div>
          </section>
        </aside>
      </div>
    </div>
  );
}

// A single existing allocation row — edit qty in place, save or delete.
function AllocationRow({ row, editable, productName }: { row: VendorProductAllocation; editable: boolean; productName: string | null }) {
  const [qty, setQty] = useState(row.allocated_qty?.toString() ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = qty !== (row.allocated_qty?.toString() ?? '');

  function save() {
    setMsg(null);
    const fd = new FormData();
    fd.set('vendor_code', row.vendor_code);
    fd.set('product_code', row.product_code);
    fd.set('allocated_qty', qty);
    start(async () => {
      const r = await saveVendorProductAllocation(fd);
      setMsg(r.ok ? 'Saved' : r.error);
    });
  }
  async function remove() {
    const ok = await confirmDelete({
      title: `Remove ${productName || row.product_code} from this vendor?`,
      body: 'Its allocated quantity is deleted from the vendor\'s capacity. This cannot be undone from the screen.',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set('id', String(row.id));
    start(async () => {
      const r = await deleteVendorProductAllocation(fd);
      if (!r.ok) setMsg(r.error);
    });
  }

  return (
    <tr>
      <td className="vc-product-cell"><strong>{productName || row.product_code}</strong><small className="mono wf-subtle">{row.product_code}</small></td>
      <td className="num input-col">
        <input type="number" min={0} value={qty} disabled={!editable} onChange={(e) => setQty(e.target.value)} />
      </td>
      <td className="wf-subtle">
        {row.entry_date ? new Date(row.entry_date).toLocaleDateString('en-IN') : '—'}
        {msg && <small className="wf-subtle"> · {msg}</small>}
      </td>
      {editable && (
        <td className="wf-row-actions">
          <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={pending || !dirty}>
            <Save size={13} /> Save
          </button>
          <button type="button" className="wf-icon-btn" aria-label="Remove" onClick={remove} disabled={pending}>
            <Trash2 size={13} />
          </button>
        </td>
      )}
    </tr>
  );
}

// New-allocation editor surfaced by the product picker after a code is chosen.
function AllocationEditor({
  vendorCode,
  productCode,
  initialQty,
  isNew,
}: {
  vendorCode: string;
  productCode: string;
  initialQty: string;
  isNew?: boolean;
}) {
  const [qty, setQty] = useState(initialQty);
  const [msg, setMsg] = useState<string | null>(null);
  const [done_, setDone] = useState(false);
  const [pending, start] = useTransition();

  function save() {
    setMsg(null);
    const fd = new FormData();
    fd.set('vendor_code', vendorCode);
    fd.set('product_code', productCode);
    fd.set('allocated_qty', qty);
    start(async () => {
      const r = await saveVendorProductAllocation(fd);
      if (r.ok) setDone(true);
      else setMsg(r.error);
    });
  }

  if (done_) return <span className="wf-subtle">Added {productCode} — {fmt.format(num(qty))} pcs.</span>;
  return (
    <span className="wf-inline-add">
      <strong className="mono">{productCode}</strong>
      <input
        type="number"
        min={0}
        placeholder="pcs/month"
        value={qty}
        autoFocus={isNew}
        onChange={(e) => setQty(e.target.value)}
      />
      <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={save} disabled={pending || !qty.trim()}>
        <Plus size={13} /> {pending ? 'Adding…' : 'Add'}
      </button>
      {msg && <small className="wf-error-text">{msg}</small>}
    </span>
  );
}

/* ------------------------------ Rules tab (item 3) ------------------------------ */

/**
 * Rules is a read-out, not a second place to edit. Every value here already belongs to the
 * shared Rules Master, so this tab shows what the capacity maths is currently using and sends
 * you there to change it. Keeping an edit box here as well meant two doors onto one setting.
 */
function RulesTab({
  leadDays,
  multipliers = [],
  rules = DEFAULT_CAPACITY_RULES,
}: {
  leadDays: { job: number; efob: number; fob: number };
  multipliers?: VendorTypeMultiplier[];
  rules?: CapacityRules;
}) {
  const leadRules = [
    { key: 'lead_days_job', label: 'Job Work lead-time', value: leadDays.job },
    { key: 'lead_days_efob', label: 'E-FOB lead-time', value: leadDays.efob },
    { key: 'lead_days_fob', label: 'FOB lead-time', value: leadDays.fob },
  ];
  // Straight from sd_vendor_type_multiplier; the code constant is only a fallback for a type
  // the master has no row for.
  const types = (multipliers.length
    ? multipliers.map((m) => ({
        key: m.vendor_type,
        label: m.label || typeConfig(m.vendor_type)?.label || m.vendor_type,
        multiplier: Number(m.multiplier),
        stockDays: Number(m.stock_days),
      }))
    : Object.entries(VENDOR_TYPE_MULTIPLIER).map(([key, v]) => ({
        key,
        label: v.label,
        multiplier: v.multiplier,
        stockDays: v.stockDays,
      }))
  ).sort((a, b) => a.stockDays - b.stockDays);
  const leadByType: Record<string, number> = {
    job_work: rules.leadDays.job_work,
    efob: rules.leadDays.efob,
    fob: rules.leadDays.fob,
  };

  return (
    <div className="vc-section">
      <Notice tone="info">
        Everything on this tab lives in the shared <strong>Rules Master</strong> — one source,
        read by the Buying Plan time-buckets, the lead-time and coverage calculations and the
        capacity maths here. This tab shows what those calculations are using right now;{' '}
        <a href="/rules-master">change the values in Rules Master</a>.
      </Notice>
      <section className="vc-card">
        <div className="vc-card-head">
          <div>
            <h2>PO lead-time defaults</h2>
            <p>Calendar days used by shared planning calculations</p>
          </div>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/rules-master">
            Edit in Rules Master →
          </a>
        </div>
        <div className="vc-formula-grid">
          {leadRules.map((r) => (
            <div key={r.key}>
              <span>{r.label}</span>
              <strong>{r.value} days</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="vc-card">
        <div className="vc-card-head">
          <div>
            <h2>Lead time by PO type</h2>
            <p>Production window per PO type — the days a PO occupies the vendor</p>
          </div>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/rules-master">
            Edit in Rules Master →
          </a>
        </div>
        <div className="vc-formula-grid">
          {types.map((t) => (
            <div key={t.key}>
              <span>{t.label}</span>
              <strong>{leadByType[t.key] ?? t.stockDays} lead days</strong>
            </div>
          ))}
        </div>
        <p className="wf-subtle vc-formula-hold">
          Vendors typed <strong>EFOB/FOB</strong> in the vendor master are read as E-FOB. The
          PO type does not change how fast a vendor sews; it changes how long a PO occupies
          the vendor, which is why PO capacity = capacity/month × lead days ÷ 30. These are
          the same lead days the Buying Plan and coverage calculations use.
        </p>
      </section>
      {/*
        This card was withheld while the capacity calculation was wrong (it multiplied
        machines by karigars, which on 14/09 turned a vendor with 40 machines and a stated
        1,000/month into a PO capacity of 2,500). The formula is now the agreed one, so the
        card is back and states it in full.
      */}
      <section className="vc-card">
        <div className="vc-card-head">
          <div>
            <h2>Capacity calculation</h2>
            <p>How the monthly figure on the Entry tab is worked out</p>
          </div>
        </div>
        <div className="vc-rule-grid">
          <div>
            <span>Workers</span>
            <strong>{rules.driverMinMachines ? 'min(machines, karigars)' : 'Karigars allocated'}</strong>
          </div>
          <div>
            <span>Pieces a worker makes in a day</span>
            <strong>{rules.dailyOutput}</strong>
          </div>
          <div>
            <span>Working days in a month</span>
            <strong>{rules.workingDays}</strong>
          </div>
          <div>
            <span>Capacity a month</span>
            <strong>workers × {rules.dailyOutput} × {rules.workingDays}</strong>
          </div>
          <div>
            <span>PO capacity</span>
            <strong>capacity a month × lead days ÷ 30</strong>
          </div>
          <div>
            <span>Available · utilisation</span>
            <strong>PO capacity − on order · on order ÷ PO capacity</strong>
          </div>
        </div>
        <p className="wf-subtle vc-formula-hold">
          One function computes these for every screen — Entry, Reporting, Vendor Performance,
          PO Approval and the dashboard&apos;s over-capacity count — so no two pages can disagree.
          Every input above is a Rules Master value: change it there and every figure follows
          on the next load, no deploy. The workers switch (karigars alone, or the smaller of
          machines and karigars) is the rule <code>capacity_driver_min_machines</code>.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------ Reporting tab (item 4) ------------------------------ */

function ReportingTab({
  vendors,
  onVendor,
  rules = DEFAULT_CAPACITY_RULES,
}: {
  vendors: Vendor[];
  onVendor: (code: string) => void;
  rules?: CapacityRules;
}) {
  // Per-vendor utilisation: capacity a month against the quantity actually on order.
  // Only vendors with a current entry are meaningful.
  const rows = useMemo(
    () =>
      vendors
        .map((v) => {
          const m = modelOf(v, rules);
          return {
            code: v.vendor_code,
            name: v.vendor_name,
            type: typeConfig(v.vendor_type)?.label ?? (v.vendor_type || '—'),
            typeKey: normaliseVendorType(v.vendor_type),
            entered: m.entered,
            cap: m.poCapacity,
            inProc: v.inProcessQty,
            util: m.capacityUtil,
          };
        })
        .filter((r) => r.entered)
        .sort((a, b) => (b.util ?? -1) - (a.util ?? -1)),
    [vendors, rules],
  );

  // PO-type pivot: aggregate capacity + in-process per vendor type → util per type.
  const pivot = useMemo(() => {
    const m = new Map<string, { label: string; cap: number; inProc: number }>();
    for (const v of vendors) {
      const key = normaliseVendorType(v.vendor_type);
      const label = typeConfig(v.vendor_type)?.label ?? (v.vendor_type || 'Unknown');
      const model = modelOf(v, rules);
      if (!model.entered) continue; // "Not entered" is not zero capacity
      const cur = m.get(key) ?? { label, cap: 0, inProc: 0 };
      cur.cap += model.poCapacity;
      cur.inProc += v.inProcessQty;
      m.set(key, cur);
    }
    return [...m.values()]
      .filter((r) => r.cap > 0 || r.inProc > 0)
      .map((r) => ({ ...r, util: r.cap > 0 ? Math.round((r.inProc / r.cap) * 1000) / 10 : null }));
  }, [vendors, rules]);

  const totalCapacity = pivot.reduce((sum, row) => sum + row.cap, 0);
  const totalInProcess = pivot.reduce((sum, row) => sum + row.inProc, 0);
  const overallUtil = totalCapacity ? Math.round((totalInProcess / totalCapacity) * 1000) / 10 : null;

  function exportRows() {
    downloadCsv('vendor-capacity-report.csv', [
      ['Vendor code', 'Vendor', 'Type', 'PO capacity', 'In process', 'Utilization %'],
      ...rows.map((row) => [row.code, row.name, row.type, row.cap, row.inProc, utilisationLabel(row.util)]),
    ]);
  }

  return (
    <div className="vc-section">
      <div className="vc-metrics">
        <CapacityMetric label="Total PO capacity" value={fmt.format(totalCapacity)} detail="pcs the vendors can make inside their lead times" />
        <CapacityMetric label="In process" value={fmt.format(totalInProcess)} detail="open production quantity" tone="blue" />
        <CapacityMetric
          label="Overall utilization"
          value={utilisationLabel(overallUtil)}
          detail={
            !totalCapacity
              ? 'No capacity entered'
              : totalInProcess > totalCapacity
                ? `${fmt.format(totalInProcess - totalCapacity)} pcs past capacity`
                : `${fmt.format(totalCapacity - totalInProcess)} pcs headroom`
          }
          tone={overallUtil != null && overallUtil >= 100 ? 'red' : 'amber'}
        />
        <CapacityMetric label="Over PO capacity" value={String(rows.filter((row) => row.util != null && row.util > 100).length)} detail="vendors with more on order than their PO capacity" tone="red" />
      </div>
      <Notice tone="info">
        Utilisation = on order ÷ <strong>PO capacity</strong>, where PO capacity is what the
        vendor can make inside its PO type&apos;s lead time (capacity/month × lead days ÷ 30; lead
        days in Rules Master: Job Work {rules.leadDays.job_work} · E-FOB {rules.leadDays.efob} · FOB {rules.leadDays.fob}).
        The same model as the Entry tab, Vendor Performance and PO Approval. Past 100% the real
        percentage is shown. Vendors with nothing entered are left out. Click a vendor to open
        its product allocation.
      </Notice>

      <div className="vc-report-grid">
      <div className="table-panel wf-grid-panel vc-report-card">
        <div className="vc-card-head"><div><h2>Utilization by PO type</h2><p>Aggregated capacity and in-process quantity</p></div></div>
        <div className="table-scroll">
          <table className="wide-table vc-type-table">
            <thead>
              <tr>
                <th>PO type <HeaderInfo label="PO type" /></th>
                <th className="num">PO capacity <HeaderInfo label="PO capacity" /></th>
                <th className="num">In process <HeaderInfo label="In process" /></th>
                <th className="num">Utilization <HeaderInfo label="Utilization" /></th>
              </tr>
            </thead>
            <tbody>
              {pivot.map((p) => (
                <tr key={p.label}>
                  <td className="strong">{p.label}</td>
                  <td className="num">{fmt.format(p.cap)}</td>
                  <td className="num">{fmt.format(p.inProc)}</td>
                  <td className="vc-util-cell"><UtilCell value={p.util} /></td>
                </tr>
              ))}
              {!pivot.length && (
                <tr>
                  <td colSpan={4} className="wf-empty-cell">No capacity entered yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="table-panel wf-grid-panel vc-report-card">
        <div className="vc-card-head"><div><h2>Utilization by vendor</h2><p>Open a vendor to review its product allocation</p></div><div className="vc-head-actions"><span className="vc-pill">{rows.length} vendors</span><button type="button" className="wf-btn wf-btn-ghost wf-btn-sm vc-export" onClick={exportRows}><Download size={13} /> Download CSV</button></div></div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Type <HeaderInfo label="Type" /></th>
                <th className="num">PO capacity <HeaderInfo label="PO capacity" /></th>
                <th className="num">In process <HeaderInfo label="In process" /></th>
                <th className="num">Utilization <HeaderInfo label="Utilization" /></th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code}>
                  <td>
                    <strong>{r.name}</strong> <small className="mono wf-subtle">{r.code}</small>
                  </td>
                  <td>{r.type}</td>
                  <td className="num">{fmt.format(r.cap)}</td>
                  <td className="num">{fmt.format(r.inProc)}</td>
                  <td className="vc-util-cell"><UtilCell value={r.util} /></td>
                  <td>
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      onClick={() => onVendor(r.code)}
                      title="Open this vendor's product allocation"
                    >
                      <ArrowUpRight size={13} /> View allocation
                    </button>
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={6} className="wf-empty-cell">No capacity entered yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      </div>
    </div>
  );
}
