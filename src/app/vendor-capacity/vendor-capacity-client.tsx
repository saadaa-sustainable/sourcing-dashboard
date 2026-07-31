'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Clock, Lock, Save } from 'lucide-react';
import { saveVendorCapacityRow } from '@/lib/forms/actions';
import { canEdit } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import type {
  SdRole,
  VendorCapacityLog,
  VendorTypeMultiplier,
} from '@/lib/forms/types';

type Vendor = {
  vendor_code: string;
  vendor_name: string;
  vendor_type: string;
  machinesAtOnboarding: number;
  capacitySigned: number;
  inProcessQty: number;
  current: VendorCapacityLog | null;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;
const STALE_DAYS = 7;
const STALE_MS = STALE_DAYS * 86_400_000;

const TYPE_LABEL: Record<string, string> = {
  job_work: 'Job work',
  efob: 'E-FOB',
  fob: 'FOB',
};

function normaliseType(raw: string) {
  const value = (raw || '').toLowerCase();
  if (value.includes('job')) return 'job_work';
  if (value.includes('e-fob') || value.includes('efob')) return 'efob';
  if (value.includes('fob')) return 'fob';
  return 'job_work';
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

export function VendorCapacityClient({
  vendors,
  multipliers,
  role,
}: {
  vendors: Vendor[];
  multipliers: VendorTypeMultiplier[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [search, setSearch] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  // Set after mount so server render never disagrees on staleness (avoids hydration
  // mismatch); until then nothing is treated as stale.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const multiplierByType = useMemo(
    () => new Map(multipliers.map((m) => [m.vendor_type.toLowerCase(), m])),
    [multipliers],
  );

  const decorated = vendors.map((vendor) => {
    const lastUpdated = vendor.current?.entry_date ?? null;
    const isStale =
      now != null && (!lastUpdated || now - new Date(lastUpdated).getTime() > STALE_MS);
    return { vendor, lastUpdated, isStale };
  });

  const overCount = decorated.filter(({ vendor }) => {
    const config = multiplierByType.get(normaliseType(vendor.vendor_type));
    const poCapacity =
      Number(vendor.current?.capacity_per_month ?? 0) * (config?.multiplier ?? 1);
    return vendor.current && poCapacity - vendor.inProcessQty < 0;
  }).length;
  const staleCount = decorated.filter((d) => d.isStale).length;

  const q = search.trim().toLowerCase();
  const filtered = decorated
    .filter(({ vendor }) =>
      q ? `${vendor.vendor_code} ${vendor.vendor_name}`.toLowerCase().includes(q) : true,
    )
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
        Update one vendor at a time — edit that vendor’s row and hit{' '}
        <strong>Save</strong>; nothing else has to be filled in.{' '}
        <span className="wf-live-tag">LIVE</span> fields are what you fill (machines
        allotted, active karigar, current capacity).{' '}
        <span className="wf-fixed-tag">
          <Lock size={10} /> FIXED
        </span>{' '}
        fields — vendor type, machines at onboarding, capacity signed — come from the
        vendor master. A vendor not updated in over {STALE_DAYS} days is flagged{' '}
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
                  Machines allotted <span className="wf-live-tag">LIVE</span>
                </th>
                <th className="num input-col">
                  Active karigar <span className="wf-live-tag">LIVE</span>
                </th>
                <th className="num input-col">
                  Capacity / month <span className="wf-live-tag">LIVE</span>
                </th>
                <th className="num">
                  At onboarding <span className="wf-fixed-tag"><Lock size={9} /></span>
                </th>
                <th className="num">
                  Signed <span className="wf-fixed-tag"><Lock size={9} /></span>
                </th>
                <th className="num">PO capacity</th>
                <th className="num">In process</th>
                <th className="num">Available</th>
                <th>Last updated</th>
                {editable && <th aria-label="Save" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ vendor, lastUpdated, isStale }) => (
                <CapacityRow
                  key={vendor.vendor_code}
                  vendor={vendor}
                  config={multiplierByType.get(normaliseType(vendor.vendor_type))}
                  editable={editable}
                  lastUpdated={lastUpdated}
                  isStale={isStale}
                  now={now}
                />
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={editable ? 12 : 11} className="wf-empty-cell">
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
          PO capacity = capacity/month (realistic ~26 working-day output) × type
          multiplier (Job ×1.0, E-FOB ×1.5, FOB ×2.5). Available = PO capacity −
          in-process. Negative = over production.
        </p>
      </div>
    </>
  );
}

function CapacityRow({
  vendor,
  config,
  editable,
  lastUpdated,
  isStale,
  now,
}: {
  vendor: Vendor;
  config: VendorTypeMultiplier | undefined;
  editable: boolean;
  lastUpdated: string | null;
  isStale: boolean;
  now: number | null;
}) {
  const initial = {
    machines_allocated: vendor.current?.machines_allocated?.toString() ?? '',
    active_karigar: vendor.current?.active_karigar?.toString() ?? '',
    capacity_per_month: vendor.current?.capacity_per_month?.toString() ?? '',
  };
  const [fields, setFields] = useState(initial);
  const [saved, setSaved] = useState<string | null>(lastUpdated);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const dirty =
    fields.machines_allocated !== initial.machines_allocated ||
    fields.active_karigar !== initial.active_karigar ||
    fields.capacity_per_month !== initial.capacity_per_month;

  const multiplier = config?.multiplier ?? 1;
  const stockDays = config?.stock_days ?? 0;
  const poCapacity = Math.round(num(fields.capacity_per_month) * multiplier);
  const available = poCapacity - vendor.inProcessQty;
  const overProduction = available < 0;

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
    payload.set('capacity_per_month', fields.capacity_per_month);
    payload.set('machines_at_onboarding', String(vendor.machinesAtOnboarding || ''));
    payload.set('capacity_signed', String(vendor.capacitySigned || ''));
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
        <span className="wf-fixed-value">{TYPE_LABEL[normaliseType(vendor.vendor_type)]}</span>
        <small className="wf-subtle">×{multiplier} · stock {stockDays}d</small>
      </td>
      {(['machines_allocated', 'active_karigar', 'capacity_per_month'] as const).map(
        (field) => (
          <td key={field} className="num input-col">
            <input
              type="number"
              min={0}
              value={fields[field]}
              disabled={!editable}
              onChange={(event) => set(field, event.target.value)}
            />
          </td>
        ),
      )}
      <td className="num wf-fixed-value">
        {vendor.machinesAtOnboarding ? fmt.format(vendor.machinesAtOnboarding) : '—'}
      </td>
      <td className="num wf-fixed-value">
        {vendor.capacitySigned ? fmt.format(vendor.capacitySigned) : '—'}
      </td>
      <td className="num">{fmt.format(poCapacity)}</td>
      <td className="num">{fmt.format(vendor.inProcessQty)}</td>
      <td className="num strong">
        {fmt.format(available)}
        {overProduction && <span className="wf-over-tag">over</span>}
      </td>
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
