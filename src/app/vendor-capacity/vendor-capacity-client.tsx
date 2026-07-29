'use client';

import { useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Lock, Send } from 'lucide-react';
import { submitVendorCapacity } from '@/lib/forms/actions';
import { canEdit, weekLabel } from '@/lib/forms/approval';
import { Field, Notice } from '@/components/forms/form-layout';
import type {
  SdRole,
  VendorCapacityLog,
  VendorTypeMultiplier,
} from '@/lib/forms/types';

type Row = {
  vendor_code: string;
  vendor_name: string;
  vendor_type: string; // normalised job_work | efob | fob (fixed, read-only)
  machines_allocated: string; // LIVE weekly
  active_karigar: string; // LIVE weekly
  capacity_per_month: string; // LIVE weekly (current capacity)
  machinesAtOnboarding: number; // ingested onboarding constant
  capacitySigned: number; // ingested onboarding constant
  inProcessQty: number;
  lastUpdated: string | null;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;

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

export function VendorCapacityClient({
  week,
  vendors,
  multipliers,
  role,
}: {
  week: string;
  vendors: Array<{
    vendor_code: string;
    vendor_name: string;
    vendor_type: string;
    machinesAtOnboarding: number;
    capacitySigned: number;
    inProcessQty: number;
    current: VendorCapacityLog | null;
    prior: VendorCapacityLog | null;
  }>;
  multipliers: VendorTypeMultiplier[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [search, setSearch] = useState('');

  const multiplierByType = useMemo(
    () => new Map(multipliers.map((m) => [m.vendor_type.toLowerCase(), m])),
    [multipliers],
  );

  const [rows, setRows] = useState<Row[]>(() =>
    vendors.map((vendor) => {
      const source = vendor.current ?? vendor.prior;
      return {
        vendor_code: vendor.vendor_code,
        vendor_name: vendor.vendor_name,
        vendor_type: normaliseType(vendor.vendor_type),
        machines_allocated: source?.machines_allocated?.toString() ?? '',
        active_karigar: source?.active_karigar?.toString() ?? '',
        capacity_per_month: source?.capacity_per_month?.toString() ?? '',
        machinesAtOnboarding: vendor.machinesAtOnboarding,
        capacitySigned: vendor.capacitySigned,
        inProcessQty: vendor.inProcessQty,
        lastUpdated: vendor.current?.submitted_at ?? null,
      };
    }),
  );

  const view = rows.map((row) => {
    const config = multiplierByType.get(row.vendor_type);
    const multiplier = config?.multiplier ?? 1;
    // capacity/month is already the vendor's realistic ~26-working-day output,
    // so it is used as-is × the type multiplier (no 30-day inflation).
    const capacity = num(row.capacity_per_month);
    const poCapacity = Math.round(capacity * multiplier);
    const available = poCapacity - row.inProcessQty;
    return {
      row,
      multiplier,
      stockDays: config?.stock_days ?? 0,
      poCapacity,
      available,
      overProduction: available < 0,
      utilisationPct: poCapacity
        ? Math.round((row.inProcessQty / poCapacity) * 100)
        : 0,
    };
  });

  const filtered = search.trim()
    ? view.filter((item) =>
        `${item.row.vendor_code} ${item.row.vendor_name}`
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
      )
    : view;

  const overCount = view.filter((item) => item.overProduction).length;

  function patch(code: string, field: keyof Row, value: string) {
    setRows((current) =>
      current.map((row) =>
        row.vendor_code === code ? { ...row, [field]: value } : row,
      ),
    );
  }

  function submit() {
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('week_of', week);
    payload.set(
      'rows',
      JSON.stringify(
        rows
          .filter(
            (row) =>
              row.capacity_per_month !== '' ||
              row.machines_allocated !== '' ||
              row.active_karigar !== '',
          )
          // The onboarding constants ride along so each weekly record keeps a
          // snapshot, but they are never typed — they come from the master.
          .map((row) => ({
            vendor_code: row.vendor_code,
            vendor_name: row.vendor_name,
            machines_allocated: row.machines_allocated,
            active_karigar: row.active_karigar,
            capacity_per_month: row.capacity_per_month,
            machines_at_onboarding: row.machinesAtOnboarding,
            capacity_signed: row.capacitySigned,
          })),
      ),
    );
    start(async () => {
      const result = await submitVendorCapacity(payload);
      if (result.ok) setMessage(result.message ?? 'Submitted.');
      else setError(result.error);
    });
  }

  return (
    <>
      <div className="wf-toolbar">
        <div className="wf-toolbar-left">
          <Field label="Capacity week">
            <input value={weekLabel(week)} readOnly />
          </Field>
          <Field label="Search vendor">
            <input
              value={search}
              placeholder="Vendor name or code"
              onChange={(event) => setSearch(event.target.value)}
            />
          </Field>
        </div>
        <div className="wf-toolbar-right">
          <span className="wf-chip">
            {view.length} vendors
            {overCount > 0 && (
              <em className="wf-chip-warn">
                <AlertTriangle size={13} /> {overCount} over production
              </em>
            )}
          </span>
        </div>
      </div>

      <Notice tone="info">
        <span className="wf-live-tag">LIVE</span> fields are what you fill each
        week (machines allotted, active karigar, current capacity).{' '}
        <span className="wf-fixed-tag">
          <Lock size={10} /> FIXED
        </span>{' '}
        fields — vendor type, machines at onboarding, capacity signed — come from
        the vendor master and can’t be edited here (a type change needs a separate
        approval). Capacity/month is the vendor’s realistic monthly output (~26
        working days), used as-is. Submit before <strong>Monday 14:00 IST</strong>;
        PPM runs at 16:00.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

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
                  <small className="wf-subtle">machines</small>
                </th>
                <th className="num input-col">
                  Active karigar <span className="wf-live-tag">LIVE</span>
                  <small className="wf-subtle">workers</small>
                </th>
                <th className="num input-col">
                  Capacity / month <span className="wf-live-tag">LIVE</span>
                  <small className="wf-subtle">pcs</small>
                </th>
                <th className="num">
                  Machines at onboarding{' '}
                  <span className="wf-fixed-tag"><Lock size={9} /></span>
                  <small className="wf-subtle">machines</small>
                </th>
                <th className="num">
                  Capacity signed <span className="wf-fixed-tag"><Lock size={9} /></span>
                  <small className="wf-subtle">pcs</small>
                </th>
                <th className="num">
                  PO capacity<small className="wf-subtle">pcs</small>
                </th>
                <th className="num">
                  In process<small className="wf-subtle">pcs</small>
                </th>
                <th className="num">
                  Available<small className="wf-subtle">pcs</small>
                </th>
                <th className="num">
                  Utilisation<small className="wf-subtle">%</small>
                </th>
                <th>Last updated</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(
                ({ row, multiplier, stockDays, poCapacity, available, overProduction, utilisationPct }) => (
                  <tr
                    key={row.vendor_code}
                    className={overProduction ? 'wf-row-over' : ''}
                  >
                    <td>
                      <strong>{row.vendor_name || row.vendor_code}</strong>
                      <small className="mono wf-subtle">{row.vendor_code}</small>
                    </td>
                    <td>
                      <span className="wf-fixed-value">
                        {TYPE_LABEL[row.vendor_type]}
                      </span>
                      <small className="wf-subtle">
                        ×{multiplier} · stock {stockDays}d
                      </small>
                    </td>
                    {(
                      ['machines_allocated', 'active_karigar', 'capacity_per_month'] as const
                    ).map((field) => (
                      <td key={field} className="num input-col">
                        <input
                          type="number"
                          min={0}
                          value={row[field]}
                          disabled={!editable}
                          onChange={(event) =>
                            patch(row.vendor_code, field, event.target.value)
                          }
                        />
                      </td>
                    ))}
                    <td className="num wf-fixed-value">
                      {row.machinesAtOnboarding
                        ? fmt.format(row.machinesAtOnboarding)
                        : '—'}
                    </td>
                    <td className="num wf-fixed-value">
                      {row.capacitySigned ? fmt.format(row.capacitySigned) : '—'}
                    </td>
                    <td className="num">{fmt.format(poCapacity)}</td>
                    <td className="num">{fmt.format(row.inProcessQty)}</td>
                    <td className="num strong">
                      {fmt.format(available)}
                      {overProduction && <span className="wf-over-tag">over</span>}
                    </td>
                    <td className="num">{utilisationPct}%</td>
                    <td className="wf-subtle">
                      {row.lastUpdated
                        ? new Date(row.lastUpdated).toLocaleDateString('en-IN')
                        : 'Not this week'}
                    </td>
                  </tr>
                ),
              )}
              {!filtered.length && (
                <tr>
                  <td colSpan={12} className="wf-empty-cell">
                    No vendors match that search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wf-footer-bar">
        <p className="wf-footer-note">
          PO capacity = current capacity/month (realistic ~26 working-day output)
          × type multiplier (Job ×1.0, E-FOB ×1.5, FOB ×2.5). Available = PO
          capacity − in-process. Negative = over production.
        </p>
        <div className="wf-footer-actions">
          {editable && (
            <button
              type="button"
              className="wf-btn wf-btn-primary"
              onClick={submit}
              disabled={pending}
            >
              <Send size={15} /> {pending ? 'Submitting…' : 'Submit capacity'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
