'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Clock, Lock, Save, Plus, Trash2, ArrowUpRight } from 'lucide-react';
import {
  saveVendorCapacityRow,
  saveVendorProductAllocation,
  deleteVendorProductAllocation,
  saveAnalyticsRule,
} from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import { ProductPicker } from '@/components/forms/product-picker';
import { VENDOR_TYPE_MULTIPLIER, normaliseVendorType } from '@/lib/business-logic';
import type {
  SdRole,
  VendorCapacityLog,
  VendorProductAllocation,
  ProductCatalogItem,
} from '@/lib/forms/types';

type Vendor = {
  vendor_code: string;
  vendor_name: string;
  vendor_type: string;
  merchant: string;
  machinesAtOnboarding: number;
  capacitySigned: number;
  inProcessQty: number;
  current: VendorCapacityLog | null;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;
const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 86_400_000;

const typeConfig = (type: string) => VENDOR_TYPE_MULTIPLIER[normaliseVendorType(type)];

// Live PO capacity for a vendor from its current machines × karigar × type multiplier.
function poCapacityOf(vendor: Vendor): number {
  const mult = typeConfig(vendor.vendor_type)?.multiplier ?? 1;
  const m = Number(vendor.current?.machines_allocated ?? 0);
  const k = Number(vendor.current?.active_karigar ?? 0);
  return Math.round(m * k * mult);
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

/* ------------------------------ Shell (item 6) ------------------------------ */

export function VendorCapacityClient({
  vendors,
  role,
  allocations = [],
  catalog = [],
  leadDays,
}: {
  vendors: Vendor[];
  role: SdRole;
  allocations?: VendorProductAllocation[];
  catalog?: ProductCatalogItem[];
  leadDays: { job: number; efob: number; fob: number };
}) {
  const [tab, setTab] = useState<TabId>('entry');
  // Click-through: Reporting → Entry/Allocation focused on one vendor.
  const [focusVendor, setFocusVendor] = useState('');

  return (
    <>
      <div className="role-tabs" role="tablist" aria-label="Vendor Capacity sections">
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

      {tab === 'entry' && <EntryTab vendors={vendors} role={role} initialSearch={focusVendor} />}
      {tab === 'allocation' && (
        <ProductAllocationTab
          vendors={vendors}
          allocations={allocations}
          catalog={catalog}
          role={role}
          initialVendor={focusVendor}
        />
      )}
      {tab === 'rules' && <RulesTab leadDays={leadDays} role={role} />}
      {tab === 'reporting' && (
        <ReportingTab
          vendors={vendors}
          onVendor={(code) => {
            setFocusVendor(code);
            setTab('allocation');
          }}
        />
      )}
    </>
  );
}

/* ------------------------------ Entry tab ------------------------------ */

function EntryTab({
  vendors,
  role,
  initialSearch,
}: {
  vendors: Vendor[];
  role: SdRole;
  initialSearch?: string;
}) {
  const editable = canEdit(role, 'draft');
  const [search, setSearch] = useState(initialSearch ?? '');
  const [staleOnly, setStaleOnly] = useState(false);
  const [merchant, setMerchant] = useState('');
  const [vType, setVType] = useState('');
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
    .filter((d) => (staleOnly ? d.isStale : true))
    .sort((a, b) => {
      const at = a.lastUpdated ? new Date(a.lastUpdated).getTime() : 0;
      const bt = b.lastUpdated ? new Date(b.lastUpdated).getTime() : 0;
      return at - bt;
    });

  return (
    <>
      <div className="wf-toolbar">
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
          <span className="wf-chip">
            {decorated.length} vendors
            {staleCount > 0 && (
              <em className="wf-chip-warn">
                <Clock size={13} /> {staleCount} stale
              </em>
            )}
            {overCount > 0 && (
              <em className="wf-chip-warn">
                <AlertTriangle size={13} /> {overCount} over production
              </em>
            )}
          </span>
        </div>
      </div>

      <Notice tone="info">
        Only <strong>two fields are ever typed</strong>:{' '}
        <span className="wf-live-tag">LIVE</span> Machines allocated and Karigar allocated.
        Everything in an <span className="wf-computed-tag">orange</span> cell is computed —
        Capacity/month = Machines × Karigar, PO capacity = Capacity/month × type multiplier,
        Available = PO capacity − in-process. First machines and Type are{' '}
        <span className="wf-fixed-tag">
          <Lock size={10} /> FIXED
        </span>{' '}
        from the vendor master. A vendor not updated in over {STALE_DAYS} days is flagged{' '}
        <strong>stale</strong>.
      </Notice>

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>
                  Type <span className="wf-fixed-tag"><Lock size={9} /></span>
                </th>
                <th className="num input-col">
                  Machines allocated <span className="wf-live-tag">LIVE</span>
                </th>
                <th className="num input-col">
                  Karigar allocated <span className="wf-live-tag">LIVE</span>
                </th>
                <th className="num">Capacity / month</th>
                <th className="num">
                  First machines <span className="wf-fixed-tag"><Lock size={9} /></span>
                </th>
                <th className="num">PO capacity</th>
                <th className="num">In process</th>
                <th className="num">Available</th>
                <th className="num">Machine util</th>
                <th className="num">Capacity util</th>
                <th>Last updated</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ vendor, lastUpdated, isStale }) => (
                <CapacityRow
                  key={vendor.vendor_code}
                  vendor={vendor}
                  editable={editable}
                  lastUpdated={lastUpdated}
                  isStale={isStale}
                  now={now}
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

      <div className="wf-footer-bar">
        <p className="wf-footer-note">
          Capacity/month = Machines × Karigar. PO capacity = Capacity/month × type multiplier
          (Job ×1.0 · E-FOB ×1.5 · FOB ×2.5 · E-FOB/FOB ×2.0). Available = PO capacity −
          in-process (negative = over production). Machine util = Karigar ÷ Machines; Capacity
          util = In-process ÷ PO capacity.
        </p>
      </div>
    </>
  );
}

function CapacityRow({
  vendor,
  editable,
  lastUpdated,
  isStale,
  now,
}: {
  vendor: Vendor;
  editable: boolean;
  lastUpdated: string | null;
  isStale: boolean;
  now: number | null;
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
  const multiplier = config?.multiplier ?? 1;
  const stockDays = config?.stockDays ?? 0;

  const machines = num(fields.machines_allocated);
  const karigar = num(fields.active_karigar);
  const capacityMonth = machines * karigar;
  const poCapacity = Math.round(capacityMonth * multiplier);
  const available = poCapacity - vendor.inProcessQty;
  const overProduction = available < 0;
  const machineUtil = machines > 0 ? Math.round((karigar / machines) * 100) : null;
  const capacityUtil = poCapacity > 0 ? Math.round((vendor.inProcessQty / poCapacity) * 100) : null;

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
      <td>
        <strong>{vendor.vendor_name || vendor.vendor_code}</strong>
        <small className="mono wf-subtle">{vendor.vendor_code}</small>
      </td>
      <td>
        <span className="wf-fixed-value">{config?.label ?? (vendor.vendor_type || '—')}</span>
        <small className="wf-subtle">×{multiplier} · stock {stockDays}d</small>
      </td>
      {(['machines_allocated', 'active_karigar'] as const).map((field) => (
        <td key={field} className="num input-col">
          <input
            type="number"
            min={0}
            value={fields[field]}
            disabled={!editable}
            onChange={(event) => set(field, event.target.value)}
          />
        </td>
      ))}
      <td className="num wf-computed">{fmt.format(capacityMonth)}</td>
      <td className="num wf-fixed-value">
        {vendor.machinesAtOnboarding ? fmt.format(vendor.machinesAtOnboarding) : '—'}
      </td>
      <td className="num wf-computed">{fmt.format(poCapacity)}</td>
      <td className="num">{fmt.format(vendor.inProcessQty)}</td>
      <td className="num wf-computed strong">
        {fmt.format(available)}
        {overProduction && <span className="wf-over-tag">over</span>}
      </td>
      <td className="num wf-computed">{machineUtil == null ? '—' : `${machineUtil}%`}</td>
      <td className="num wf-computed">{capacityUtil == null ? '—' : `${capacityUtil}%`}</td>
      <td className="wf-subtle">
        {ageLabel(saved, now)}
        {isStale && !dirty && <span className="wf-over-tag">stale</span>}
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

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Vendor">
            <select
              className="meta-select"
              value={vendorCode}
              onChange={(e) => setVendorCode(e.target.value)}
            >
              {vendors.map((v) => (
                <option key={v.vendor_code} value={v.vendor_code}>
                  {v.vendor_name} ({v.vendor_code})
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="wf-toolbar-right">
          <span className="wf-chip">
            {fmt.format(allocated)} / {capacity ? fmt.format(capacity) : '—'} pcs allocated
            {over && (
              <em className="wf-chip-warn">
                <AlertTriangle size={13} /> over capacity
              </em>
            )}
          </span>
        </div>
      </div>

      <Notice tone={over ? 'warn' : 'info'}>
        Allocate how many pieces/month of each product this vendor is committed to — absolute
        pieces, not a percentage. The total is checked against the vendor&rsquo;s monthly capacity
        ({capacity ? fmt.format(capacity) : 'not set'}); going over is <strong>warned, not blocked</strong>.
      </Notice>

      {editable && vendor && (
        <div className="wf-form-panel">
          <Field label="Add a product" hint="search by code or name — from the product master">
            <ProductPicker
              items={catalog}
              exclude={existingCodes}
              onPick={(code) => setNewCode(code)}
              placeholder="Search product code or name…"
            />
          </Field>
          {newCode && (
            <AllocationEditor
              key={newCode}
              vendorCode={vendorCode}
              productCode={newCode}
              initialQty=""
              isNew
            />
          )}
        </div>
      )}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Product</th>
                <th className="num input-col">Allocated (pcs/month)</th>
                <th>Last set</th>
                {editable && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AllocationRow key={r.id} row={r} editable={editable} />
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={editable ? 4 : 3} className="wf-empty-cell">
                    No product allocations for this vendor yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// A single existing allocation row — edit qty in place, save or delete.
function AllocationRow({ row, editable }: { row: VendorProductAllocation; editable: boolean }) {
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
      <td className="mono">{row.product_code}</td>
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

function RulesTab({
  leadDays,
  role,
}: {
  leadDays: { job: number; efob: number; fob: number };
  role: SdRole;
}) {
  const editable = role === 'admin';
  const rules = [
    { key: 'lead_days_job', label: 'Job Work lead-time (days)', value: leadDays.job },
    { key: 'lead_days_efob', label: 'E-FOB lead-time (days)', value: leadDays.efob },
    { key: 'lead_days_fob', label: 'FOB lead-time (days)', value: leadDays.fob },
  ];
  return (
    <>
      <Notice tone="info">
        These day-counts live in the shared <strong>Rules Master</strong> (one source) — the
        Buying Plan time-buckets and lead-time/coverage calcs read the same values. FOB is settled
        at {leadDays.fob} days. {editable ? 'Edit below (admin).' : 'Only an admin can change them.'}
      </Notice>
      <div className="wf-rule-list" style={{ maxWidth: 520 }}>
        {rules.map((r) => (
          <RuleRow key={r.key} ruleKey={r.key} label={r.label} value={r.value} editable={editable} />
        ))}
      </div>
    </>
  );
}

function RuleRow({
  ruleKey,
  label,
  value,
  editable,
}: {
  ruleKey: string;
  label: string;
  value: number;
  editable: boolean;
}) {
  const [val, setVal] = useState(String(value));
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = val !== String(value);

  function save() {
    setMsg(null);
    const fd = new FormData();
    fd.set('rule_key', ruleKey);
    fd.set('value', val);
    start(async () => {
      const r = await saveAnalyticsRule(fd);
      setMsg(r.ok ? 'Saved — applies on next load' : r.error);
    });
  }

  return (
    <div className="wf-rule-row">
      <div className="wf-rule-meta">
        <span className="wf-rule-label">{label}</span>
        <span className="wf-rule-key"><code>{ruleKey}</code></span>
      </div>
      <div className="wf-rule-edit">
        {editable ? (
          <>
            <input
              type="number"
              min={1}
              className="wf-rule-input"
              value={val}
              onChange={(e) => setVal(e.target.value)}
            />
            <button type="button" className="wf-btn wf-btn-primary wf-rule-save" onClick={save} disabled={pending || !dirty}>
              {pending ? 'Saving…' : 'Save'}
            </button>
          </>
        ) : (
          <strong className="wf-rule-value">{value}</strong>
        )}
      </div>
      {msg && <p className="wf-rule-error" style={{ color: msg.startsWith('Saved') ? 'var(--ink-2)' : '#c0392b' }}>{msg}</p>}
    </div>
  );
}

/* ------------------------------ Reporting tab (item 4) ------------------------------ */

function ReportingTab({
  vendors,
  onVendor,
}: {
  vendors: Vendor[];
  onVendor: (code: string) => void;
}) {
  // Per-vendor utilization from the kept interim formula (PO capacity = machines ×
  // karigar × type multiplier). Only vendors with a current entry are meaningful.
  const rows = useMemo(
    () =>
      vendors
        .map((v) => {
          const cap = poCapacityOf(v);
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
    [vendors],
  );

  // PO-type pivot: aggregate capacity + in-process per vendor type → util per type.
  const pivot = useMemo(() => {
    const m = new Map<string, { label: string; cap: number; inProc: number }>();
    for (const v of vendors) {
      const key = normaliseVendorType(v.vendor_type);
      const label = typeConfig(v.vendor_type)?.label ?? (v.vendor_type || 'Unknown');
      const cur = m.get(key) ?? { label, cap: 0, inProc: 0 };
      cur.cap += poCapacityOf(v);
      cur.inProc += v.inProcessQty;
      m.set(key, cur);
    }
    return [...m.values()]
      .filter((r) => r.cap > 0 || r.inProc > 0)
      .map((r) => ({ ...r, util: r.cap > 0 ? Math.round((r.inProc / r.cap) * 100) : null }));
  }, [vendors]);

  const utilClass = (u: number | null) =>
    u == null ? '' : u > 100 ? 'wf-over-tag' : u >= 70 ? '' : '';

  return (
    <>
      <Notice tone="info">
        Utilization = in-process ÷ PO capacity, where PO capacity uses the <strong>interim</strong>{' '}
        capacity multiplier (Job ×1.0 · E-FOB ×1.5 · FOB ×2.5) — the same basis as Vendor
        Performance. Over 100% = over-committed. Click a vendor to open its product allocation.
      </Notice>

      <div className="table-panel wf-grid-panel">
        <div className="table-meta">
          <h3>Utilization by PO type</h3>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
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
                  <td className="num">
                    {p.util == null ? '—' : `${p.util}%`}
                    {p.util != null && p.util > 100 && <span className="wf-over-tag">over</span>}
                  </td>
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

      <div className="table-panel wf-grid-panel" style={{ marginTop: 16 }}>
        <div className="table-meta">
          <h3>Utilization by vendor</h3>
          <span>{rows.length} vendors</span>
        </div>
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
                  <td className={`num ${utilClass(r.util)}`}>
                    {r.util == null ? '—' : `${r.util}%`}
                    {r.util != null && r.util > 100 && <span className="wf-over-tag">over</span>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="wf-btn wf-btn-ghost wf-btn-sm"
                      onClick={() => onVendor(r.code)}
                      title="Open this vendor's product allocation"
                    >
                      <ArrowUpRight size={13} /> Detail
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
    </>
  );
}
