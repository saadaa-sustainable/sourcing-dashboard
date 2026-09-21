'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Clock, Download, Lock, Save, Plus, Trash2, ArrowUpRight } from 'lucide-react';
import {
  saveVendorCapacityRow,
  saveVendorProductAllocation,
  deleteVendorProductAllocation,
} from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { useColumnSort } from '@/lib/use-column-sort';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import { DeboardedPill } from '@/components/forms/deboarded-pill';
import {
  KARIGAR_DAILY_OUTPUT,
  VENDOR_TYPE_MULTIPLIER,
  WORKING_DAYS_PER_MONTH,
  normaliseVendorType,
  vendorMonthlyCapacity,
} from '@/lib/business-logic';
import type {
  DeboardedVendor,
  SdRole,
  VendorCapacityLog,
  VendorProductAllocation,
  VendorTypeMultiplier,
  ProductCatalogItem,
} from '@/lib/forms/types';
import './vendor-capacity.css';

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

// Live monthly capacity for a vendor: karigars × pieces per karigar per day × working days.
function poCapacityOf(vendor: Vendor, dailyOutput = KARIGAR_DAILY_OUTPUT, workingDays = WORKING_DAYS_PER_MONTH): number {
  return vendorMonthlyCapacity(vendor.current?.active_karigar, dailyOutput, workingDays);
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
  if (value >= 100) return <span className="vc-over-text">100% and Over Utilised</span>;
  return (
    <>
      <span className={`vc-pill ${value >= 85 ? 'vc-pill-amber' : 'vc-pill-green'}`}>{value}%</span>
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

export function VendorCapacityClient({
  vendors,
  role,
  allocations = [],
  catalog = [],
  leadDays,
  multipliers = [],
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
}: {
  vendors: Vendor[];
  role: SdRole;
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  leadDays: { job: number; efob: number; fob: number };
  /** Vendor-type multipliers straight from the sd_vendor_type_multiplier master. */
  multipliers?: VendorTypeMultiplier[];
  /** Both from Rules Master, so the capacity formula changes without a deploy. */
  dailyOutput?: number;
  workingDays?: number;
}) {
  const [tab, setTab] = useState<TabId>('entry');
  // Click-through: Reporting → Entry/Allocation focused on one vendor.
  const [focusVendor, setFocusVendor] = useState('');

  return (
    <div className="vc-page">
      <div className="role-tabs vc-tabs" role="tablist" aria-label="Vendor Capacity sections">
        {TABS.map(([id, label]) => (
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
        <EntryTab
          vendors={vendors}
          role={role}
          initialSearch={focusVendor}
          allocations={allocations}
          catalog={catalog}
          dailyOutput={dailyOutput}
          workingDays={workingDays}
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
          dailyOutput={dailyOutput}
          workingDays={workingDays}
        />
      )}
      {tab === 'reporting' && (
        <ReportingTab
          vendors={vendors}
          dailyOutput={dailyOutput}
          workingDays={workingDays}
          onVendor={(code) => {
            setFocusVendor(code);
            setTab('allocation');
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------ Entry tab ------------------------------ */

function EntryTab({
  vendors,
  role,
  initialSearch,
  allocations = [],
  catalog = [],
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
}: {
  vendors: Vendor[];
  role: SdRole;
  initialSearch?: string;
  /** Product allocations, so the sheet can be narrowed to who makes a given product. */
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  dailyOutput?: number;
  workingDays?: number;
}) {
  const editable = canEdit(role, 'draft');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [staleOnly, setStaleOnly] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [vType, setVType] = useState('');
  // Third filter alongside merchandiser and type: which vendors are committed to a product.
  const [product, setProduct] = useState('');
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

  const decorated = useMemo(
    () =>
      vendors.map((vendor) => {
        const lastUpdated = vendor.current?.entry_date ?? null;
        const isStale =
          now != null && (!lastUpdated || now - new Date(lastUpdated).getTime() > STALE_MS);
        return { vendor, lastUpdated, isStale };
      }),
    [vendors, now],
  );

  const overCount = decorated.filter(({ vendor }) => poCapacityOf(vendor) - vendor.inProcessQty < 0).length;
  const staleCount = decorated.filter((d) => d.isStale).length;

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
  const visibleCapacity = filtered.reduce((total, { vendor }) => total + poCapacityOf(vendor), 0);
  const visibleInProcess = filtered.reduce((total, { vendor }) => total + vendor.inProcessQty, 0);
  const visibleOver = filtered.filter(({ vendor }) => poCapacityOf(vendor) < vendor.inProcessQty).length;
  const visibleStale = filtered.filter(({ isStale }) => isStale).length;

  function exportRows() {
    downloadCsv('vendor-capacity-entry.csv', [
      ['Vendor code', 'Vendor', 'Merchandiser', 'Type', 'Machines allocated', 'Karigar allocated', 'Capacity/month', 'First machines', 'PO capacity', 'In process', 'Available', 'Machine util %', 'Capacity util %', 'Last updated'],
      ...sort.apply(filtered).map(({ vendor, lastUpdated }) => {
        const machines = Number(vendor.current?.machines_allocated ?? 0);
        const karigar = Number(vendor.current?.active_karigar ?? 0);
        const poCapacity = poCapacityOf(vendor);
        return [vendor.vendor_code, vendor.vendor_name, vendor.merchant, vendor.vendor_type, machines, karigar, machines * karigar, vendor.machinesAtOnboarding, poCapacity, vendor.inProcessQty, poCapacity - vendor.inProcessQty, machines ? Math.round(karigar / machines * 100) : null, poCapacity ? Math.round(vendor.inProcessQty / poCapacity * 100) : null, lastUpdated];
      }),
    ]);
  }

  return (
    <div className="vc-section">
      <div className="vc-metrics">
        <CapacityMetric label="PO capacity" value={fmt.format(visibleCapacity)} detail={`${filtered.length} vendors · pcs/month`} />
        <CapacityMetric label="In process" value={fmt.format(visibleInProcess)} detail={visibleCapacity ? `${Math.round(visibleInProcess / visibleCapacity * 100)}% of capacity` : 'pcs in production'} tone="blue" />
        <CapacityMetric label="100% and over Utilised" value={String(visibleOver)} detail="vendors at or past capacity" tone="red" />
        <CapacityMetric label="Stale updates" value={String(visibleStale)} detail={`older than ${STALE_DAYS} days`} tone="amber" />
      </div>

      <div className="wf-toolbar vc-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Search vendor">
            <input
              value={search}
              placeholder="Vendor name or code"
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
                <AlertTriangle size={13} /> {overCount} at 100% and over Utilised
              </em>
            )}
          </span>
        </div>
      </div>

      <Notice tone="info">
        Only <strong>two fields are ever typed</strong>:{' '}
        <span className="wf-live-tag">LIVE</span> Machines allocated and Karigar allocated.
        Everything in an <span className="wf-computed-tag">orange</span> cell is computed —
        Capacity/month = Karigars × pieces per karigar per day × working days a month
        (both editable in Rules Master); On order is the quantity on open POs,
        Available = PO capacity − in-process. First machines and Type are{' '}
        <span className="wf-fixed-tag">
          <Lock size={10} /> FIXED
        </span>{' '}
        from the vendor master. A vendor not updated in over {STALE_DAYS} days is flagged{' '}
        <strong>stale</strong>.
      </Notice>

      <div className="table-panel wf-grid-panel vc-table-card">
        <div className="vc-card-head">
          <div><h2>Capacity worklist</h2><p>Update machines and karigar for one vendor, then save that row.</p></div>
          <span className="vc-pill vc-pill-blue">Per-vendor save · no approval</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th {...sort.th('vendor', (d) => d.vendor.vendor_name || d.vendor.vendor_code)}>Vendor {sort.ind('vendor')}</th>
                <th {...sort.th('type', (d) => d.vendor.vendor_type)}>
                  Type <span className="wf-fixed-tag"><Lock size={9} /></span> {sort.ind('type')}
                </th>
                <th className="num input-col" {...sort.th('machines', (d) => d.vendor.current?.machines_allocated ?? null)}>
                  Machines allocated <span className="wf-live-tag">LIVE</span> {sort.ind('machines')}
                </th>
                <th className="num input-col" {...sort.th('karigar', (d) => d.vendor.current?.active_karigar ?? null)}>
                  Karigar allocated <span className="wf-live-tag">LIVE</span> {sort.ind('karigar')}
                </th>
                <th className="num">Capacity / month</th>
                <th className="num">
                  First machines <span className="wf-fixed-tag"><Lock size={9} /></span>
                </th>
                <th className="num">On order (in process)</th>
                <th className="num">Available</th>
                <th className="num">Machine util</th>
                <th className="num">Capacity util</th>
                <th {...sort.th('updated', (d) => d.lastUpdated ?? '')}>Last updated {sort.ind('updated')}</th>
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
                  now={now}
                  dailyOutput={dailyOutput}
                  workingDays={workingDays}
                />
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={editable ? 12 : 11} className="wf-empty-cell">
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
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
}: {
  vendor: Vendor;
  editable: boolean;
  lastUpdated: string | null;
  isStale: boolean;
  now: number | null;
  /** Both from Rules Master, so the formula is editable without a deploy. */
  dailyOutput?: number;
  workingDays?: number;
}) {
  const initial = {
    machines_allocated: vendor.current?.machines_allocated?.toString() ?? '',
    active_karigar: vendor.current?.active_karigar?.toString() ?? '',
  };
  const [fields, setFields] = useState(initial);
  const [saved, setSaved] = useState<string | null>(lastUpdated);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty =
    fields.machines_allocated !== initial.machines_allocated ||
    fields.active_karigar !== initial.active_karigar;

  const config = typeConfig(vendor.vendor_type);
  const stockDays = config?.stockDays ?? 0;

  const machines = num(fields.machines_allocated);
  const karigar = num(fields.active_karigar);
  /* Capacity is what the people can make in a month: karigars × pieces per karigar per day ×
     working days. Machines are still recorded and still drive machine utilisation, but they
     no longer decide output, and neither does the commercial type — a vendor does not sew
     faster because the terms are FOB.

     The column beside it is the quantity actually on order, which is the thing to compare
     capacity against. It used to be capacity multiplied again by the type, which was not a
     second fact, just the same guess scaled. */
  const capacityMonth = vendorMonthlyCapacity(karigar, dailyOutput, workingDays);
  const inProcess = vendor.inProcessQty;
  const available = capacityMonth - inProcess;
  const overProduction = available < 0;
  const machineUtil = machines > 0 ? Math.round((karigar / machines) * 100) : null;
  const capacityUtil = capacityMonth > 0 ? Math.round((inProcess / capacityMonth) * 100) : null;

  function set(field: keyof typeof fields, value: string) {
    setFields((cur) => ({ ...cur, [field]: value }));
  }

  function save() {
    setError(null);
    const payload = new FormData();
    payload.set('vendor_code', vendor.vendor_code);
    payload.set('vendor_name', vendor.vendor_name);
    payload.set('machines_allocated', fields.machines_allocated);
    payload.set('active_karigar', fields.active_karigar);
    payload.set('capacity_per_month', String(capacityMonth || ''));
    start(async () => {
      const result = await saveVendorCapacityRow(payload);
      if (result.ok) setSaved(new Date().toISOString());
      else setError(result.error);
    });
  }

  return (
    <tr className={overProduction ? 'wf-row-over' : isStale ? 'wf-row-stale' : ''}>
      <td className="vc-vendor-cell">
        <strong>{vendor.vendor_name || vendor.vendor_code}</strong>
        <small className="mono wf-subtle">{vendor.vendor_code}{vendor.merchant ? ` · ${vendor.merchant}` : ''}</small>
        <DeboardedPill flag={vendor.deboarded} />
      </td>
      <td>
        <span className="vc-pill">{config?.label ?? (vendor.vendor_type || '—')}</span>
        <small className="wf-subtle">stock {stockDays}d</small>
      </td>
      {(['machines_allocated', 'active_karigar'] as const).map((field) => (
        <td key={field} className="num input-col">
          <input
            type="number"
            min={0}
            value={fields[field]}
            disabled={!editable}
            aria-label={`${field === 'machines_allocated' ? 'Machines allocated' : 'Karigar allocated'} for ${vendor.vendor_name || vendor.vendor_code}`}
            onChange={(event) => set(field, event.target.value)}
          />
        </td>
      ))}
      <td className="num wf-computed">{fmt.format(capacityMonth)}</td>
      <td className="num wf-fixed-value">
        {vendor.machinesAtOnboarding ? fmt.format(vendor.machinesAtOnboarding) : '—'}
      </td>
      <td className="num">{fmt.format(inProcess)}</td>
      {/* Once a vendor is past capacity the headroom number is negative and only says how
          far past, which is not a figure anyone acts on. Say the state instead. */}
      <td className="num wf-computed strong">
        {overProduction ? (
          <span className="vc-over-text">Over Utilised</span>
        ) : (
          fmt.format(available)
        )}
      </td>
      <td className="num wf-computed">{machineUtil == null ? '—' : `${machineUtil}%`}</td>
      {/* Full is full. A vendor reading 147% is not half again as busy as one reading 100%
          — both are booked out, and the figure past 100 only reflects how far the backlog
          runs beyond a month. So the column stops at 100% and turns red; Available beside it
          already says "Over Utilised". */}
      <td className={`num wf-computed${capacityUtil != null && capacityUtil >= 100 ? ' vc-util-over' : ''}`}>
        {capacityUtil == null ? '—' : `${Math.min(capacityUtil, 100)}%`}
      </td>
      <td className="wf-subtle">
        {ageLabel(saved, now)}
        {isStale && !dirty && <span className="vc-pill vc-pill-amber">Stale</span>}
        {error && <small className="wf-error-text">{error}</small>}
      </td>
      {editable && (
        <td>
          <button
            type="button"
            className="wf-btn wf-btn-primary wf-btn-sm"
            onClick={save}
            disabled={pending || !dirty}
          >
            <Save size={14} /> {pending ? 'Saving…' : 'Save'}
          </button>
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
              <thead><tr><th>Product</th><th className="num input-col">Allocated (pcs/month)</th><th>Last set</th>{editable && <th aria-label="Actions" />}</tr></thead>
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
                  <ProductPicker items={catalog} exclude={existingCodes} onPick={(code) => setNewCode(code)} placeholder="Search product code or name…" />
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
  function remove() {
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
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
}: {
  leadDays: { job: number; efob: number; fob: number };
  multipliers?: VendorTypeMultiplier[];
  dailyOutput?: number;
  workingDays?: number;
}) {
  const rules = [
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
          {rules.map((r) => (
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
            <h2>Stock cover by PO type</h2>
            <p>Days of stock each PO type is expected to carry</p>
          </div>
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href="/rules-master">
            Edit in Rules Master →
          </a>
        </div>
        <div className="vc-formula-grid">
          {types.map((t) => (
            <div key={t.key}>
              <span>{t.label}</span>
              <strong>{t.stockDays} days of stock</strong>
            </div>
          ))}
        </div>
        <p className="wf-subtle vc-formula-hold">
          Vendors typed <strong>EFOB/FOB</strong> in the vendor master are read as E-FOB.
          The PO type sets lead time and stock cover only — it does not change how much a
          vendor can make, so it no longer enters the capacity figure above.
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
            <span>Capacity a month</span>
            <strong>Karigars × {dailyOutput} × {workingDays}</strong>
          </div>
          <div>
            <span>Pieces a karigar makes in a day</span>
            <strong>{dailyOutput}</strong>
          </div>
          <div>
            <span>Working days in a month</span>
            <strong>{workingDays}</strong>
          </div>
          <div>
            <span>Available</span>
            <strong>Capacity a month − quantity on order</strong>
          </div>
        </div>
        <p className="wf-subtle vc-formula-hold">
          Karigars are the ones who sew, so karigars set the output. Machines are still
          recorded and still drive machine utilisation, but they do not decide how much a
          vendor can make, and neither does the commercial type — a vendor does not sew faster
          because the terms are FOB. The type sets lead time and stock days, above.
          Both numbers in this formula come from Rules Master and can be changed there.
        </p>
      </section>
    </div>
  );
}

/* ------------------------------ Reporting tab (item 4) ------------------------------ */

function ReportingTab({
  vendors,
  onVendor,
  dailyOutput = KARIGAR_DAILY_OUTPUT,
  workingDays = WORKING_DAYS_PER_MONTH,
}: {
  vendors: Vendor[];
  onVendor: (code: string) => void;
  dailyOutput?: number;
  workingDays?: number;
}) {
  // Per-vendor utilisation: capacity a month against the quantity actually on order.
  // Only vendors with a current entry are meaningful.
  const rows = useMemo(
    () =>
      vendors
        .map((v) => {
          const cap = poCapacityOf(v, dailyOutput, workingDays);
          return {
            code: v.vendor_code,
            name: v.vendor_name,
            type: typeConfig(v.vendor_type)?.label ?? (v.vendor_type || '—'),
            typeKey: normaliseVendorType(v.vendor_type),
            cap,
            inProc: v.inProcessQty,
            util: cap > 0 ? Math.round((v.inProcessQty / cap) * 100) : null,
          };
        })
        .filter((r) => r.cap > 0 || r.inProc > 0)
        .sort((a, b) => (b.util ?? -1) - (a.util ?? -1)),
    [vendors, dailyOutput, workingDays],
  );

  // PO-type pivot: aggregate capacity + in-process per vendor type → util per type.
  const pivot = useMemo(() => {
    const m = new Map<string, { label: string; cap: number; inProc: number }>();
    for (const v of vendors) {
      const key = normaliseVendorType(v.vendor_type);
      const label = typeConfig(v.vendor_type)?.label ?? (v.vendor_type || 'Unknown');
      const cur = m.get(key) ?? { label, cap: 0, inProc: 0 };
      cur.cap += poCapacityOf(v, dailyOutput, workingDays);
      cur.inProc += v.inProcessQty;
      m.set(key, cur);
    }
    return [...m.values()]
      .filter((r) => r.cap > 0 || r.inProc > 0)
      .map((r) => ({ ...r, util: r.cap > 0 ? Math.round((r.inProc / r.cap) * 100) : null }));
  }, [vendors, dailyOutput, workingDays]);

  const totalCapacity = pivot.reduce((sum, row) => sum + row.cap, 0);
  const totalInProcess = pivot.reduce((sum, row) => sum + row.inProc, 0);
  const overallUtil = totalCapacity ? Math.round(totalInProcess / totalCapacity * 100) : null;

  function exportRows() {
    downloadCsv('vendor-capacity-report.csv', [
      ['Vendor code', 'Vendor', 'Type', 'PO capacity', 'In process', 'Utilization %'],
      ...rows.map((row) => [row.code, row.name, row.type, row.cap, row.inProc, row.util]),
    ]);
  }

  return (
    <div className="vc-section">
      <div className="vc-metrics">
        <CapacityMetric label="Total PO capacity" value={fmt.format(totalCapacity)} detail="pcs / month" />
        <CapacityMetric label="In process" value={fmt.format(totalInProcess)} detail="open production quantity" tone="blue" />
        <CapacityMetric
          label="Overall utilization"
          value={
            overallUtil == null ? '—' : overallUtil >= 100 ? '100% and Over Utilised' : `${overallUtil}%`
          }
          detail={
            !totalCapacity
              ? 'No capacity entered'
              : totalInProcess > totalCapacity
                ? `${fmt.format(totalInProcess - totalCapacity)} pcs past capacity`
                : `${fmt.format(totalCapacity - totalInProcess)} pcs headroom`
          }
          tone={overallUtil != null && overallUtil >= 100 ? 'red' : 'amber'}
        />
        <CapacityMetric label="100% and over Utilised" value={String(rows.filter((row) => row.util != null && row.util >= 100).length)} detail="vendors at or past capacity" tone="red" />
      </div>
      <Notice tone="info">
        Utilization = in-process ÷ PO capacity, where PO capacity uses the <strong>interim</strong>{' '}
        capacity multiplier (Job ×1.0 · E-FOB ×1.5 · FOB ×2.5) — the same basis as Vendor
        Performance. At or past 100% a row reads <strong>100% and Over Utilised</strong> instead
        of a percentage. Click a vendor to open its product allocation.
      </Notice>

      <div className="vc-report-grid">
      <div className="table-panel wf-grid-panel vc-report-card">
        <div className="vc-card-head"><div><h2>Utilization by PO type</h2><p>Aggregated capacity and in-process quantity</p></div></div>
        <div className="table-scroll">
          <table className="wide-table vc-type-table">
            <thead>
              <tr>
                <th>PO type</th>
                <th className="num">PO capacity</th>
                <th className="num">In process</th>
                <th className="num">Utilization</th>
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
                <th>Vendor</th>
                <th>Type</th>
                <th className="num">PO capacity</th>
                <th className="num">In process</th>
                <th className="num">Utilization</th>
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
