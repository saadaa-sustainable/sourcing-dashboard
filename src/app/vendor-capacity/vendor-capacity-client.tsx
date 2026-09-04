'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Clock, Lock, Save } from 'lucide-react';
import { saveVendorCapacityRow } from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import { VENDOR_TYPE_MULTIPLIER, normaliseVendorType } from '@/lib/business-logic';
import type { SdRole, VendorCapacityLog } from '@/lib/forms/types';

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

export function VendorCapacityClient({
  vendors,
  role,
}: {
  vendors: Vendor[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [search, setSearch] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  // Item 2 — merchandiser + vendor-type filters (same dimensions as Open PO Tracker),
  // so it's easy to spot which merchant hasn't filled their vendors' capacity yet.
  const [merchant, setMerchant] = useState('');
  const [vType, setVType] = useState('');
  const merchants = useMemo(
    () => [...new Set(vendors.map((v) => v.merchant.trim()).filter(Boolean))].sort(),
    [vendors],
  );
  const vTypes = useMemo(
    () => [...new Set(vendors.map((v) => v.vendor_type.trim()).filter(Boolean))].sort(),
    [vendors],
  );
  // Set after mount so server render never disagrees on staleness (avoids hydration
  // mismatch); until then nothing is treated as stale.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

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

  const overCount = decorated.filter(({ vendor }) => {
    if (!vendor.current) return false;
    const mult = typeConfig(vendor.vendor_type)?.multiplier ?? 1;
    const m = Number(vendor.current.machines_allocated ?? 0);
    const k = Number(vendor.current.active_karigar ?? 0);
    const poCap = Math.round(m * k * mult);
    return poCap - vendor.inProcessQty < 0;
  }).length;
  const staleCount = decorated.filter((d) => d.isStale).length;

  const q = search.trim().toLowerCase();
  const filtered = decorated
    .filter(({ vendor }) =>
      q ? `${vendor.vendor_code} ${vendor.vendor_name}`.toLowerCase().includes(q) : true,
    )
    .filter(({ vendor }) => (merchant ? vendor.merchant.trim() === merchant : true))
    .filter(({ vendor }) => (vType ? vendor.vendor_type.trim() === vType : true))
    .filter((d) => (staleOnly ? d.isStale : true))
    // Oldest / never-updated first so stale vendors surface at the top.
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
                      : 'No vendors match that search.'}
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
  const capacityMonth = machines * karigar; // Machines × Karigar
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
    // Capacity/month is derived (Machines × Karigar) — stored for history, never typed.
    payload.set('capacity_per_month', String(capacityMonth || ''));
    start(async () => {
      const result = await saveVendorCapacityRow(payload);
      // On success revalidation refreshes props, which resets the dirty baseline;
      // we just stamp the row's "last updated" immediately for feedback.
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
