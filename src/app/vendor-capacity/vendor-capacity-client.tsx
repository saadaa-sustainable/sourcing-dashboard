'use client';

import { useMemo, useState, useTransition } from 'react';
import { AlertTriangle, Send } from 'lucide-react';
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
  vendor_type: string;
  machines_allocated: string;
  active_karigar: string;
  capacity_per_month: string;
  machines_at_onboarding: string;
  capacity_signed: string;
  inProcessQty: number;
  lastUpdated: string | null;
};

const fmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const num = (value: string) => Number(value) || 0;

function normaliseType(raw: string) {
  const value = raw.toLowerCase();
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
        machines_at_onboarding: source?.machines_at_onboarding?.toString() ?? '',
        capacity_signed: source?.capacity_signed?.toString() ?? '',
        inProcessQty: vendor.inProcessQty,
        lastUpdated: vendor.current?.submitted_at ?? null,
      };
    }),
  );

  const view = rows.map((row) => {
    const config = multiplierByType.get(row.vendor_type);
    const multiplier = config?.multiplier ?? 1;
    const capacity = num(row.capacity_per_month);
    const poCapacity = capacity * multiplier;
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
        rows.filter(
          (row) =>
            row.capacity_per_month !== '' ||
            row.machines_allocated !== '' ||
            row.active_karigar !== '',
        ),
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
        Submit before <strong>Monday 14:00 IST</strong> — the PPM runs at 16:00.
        Every submission is appended as its own weekly record; nothing is
        overwritten across weeks.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="table-panel wf-grid-panel">
        <div className="table-scroll">
          <table className="wide-table wf-grid">
            <thead>
              <tr>
                <th>Vendor</th>
                <th>Type</th>
                <th className="num input-col">Machines allotted</th>
                <th className="num input-col">Active karigar</th>
                <th className="num input-col">Capacity / month</th>
                <th className="num input-col">Machines at onboarding</th>
                <th className="num input-col">Capacity signed</th>
                <th className="num">PO capacity</th>
                <th className="num">In process</th>
                <th className="num">Available</th>
                <th className="num">Utilisation</th>
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
                      <select
                        value={row.vendor_type}
                        disabled={!editable}
                        onChange={(event) =>
                          patch(row.vendor_code, 'vendor_type', event.target.value)
                        }
                      >
                        <option value="job_work">Job work</option>
                        <option value="efob">E-FOB</option>
                        <option value="fob">FOB</option>
                      </select>
                      <small className="wf-subtle">
                        ×{multiplier} · {stockDays}d
                      </small>
                    </td>
                    {(
                      [
                        'machines_allocated',
                        'active_karigar',
                        'capacity_per_month',
                        'machines_at_onboarding',
                        'capacity_signed',
                      ] as const
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
                    <td className="num">{fmt.format(poCapacity)}</td>
                    <td className="num">{fmt.format(row.inProcessQty)}</td>
                    <td className="num strong">
                      {fmt.format(available)}
                      {overProduction && (
                        <span className="wf-over-tag">over</span>
                      )}
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
          Available PO capacity = (capacity × vendor-type multiplier) − in-process
          quantity. A negative value is over production.
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
