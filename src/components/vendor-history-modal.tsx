'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { History, X } from 'lucide-react';
import { getVendorPoHistory } from '@/lib/forms/actions';
import type { VendorPoHistory } from '@/lib/forms/queries-modules/vendor';

const n0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const day = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: '2-digit',
        timeZone: 'UTC',
      })
    : '—';

/** "3 days late" / "on time" / "2 days early" — how a PO landed against its promised date. */
function Late({ days }: { days: number | null }) {
  if (days == null) return <span className="wf-subtle">—</span>;
  if (days > 0) return <span className="wf-over-tag">{days}d late</span>;
  if (days === 0) return <span className="wf-tna-ok">on time</span>;
  return <span className="wf-tna-ok">{Math.abs(days)}d early</span>;
}

/**
 * Spec 7.8 — one vendor's record, PO by PO.
 *
 * The two figures at the top answer different questions, and mixing them up is how a TNA
 * gets argued about: the LAST PO is their most recent one for THIS product — the closest
 * thing to "what will this one take" — while the AVERAGE is across everything they have
 * ever finished for us. Only completed POs count; an open one has no duration yet.
 */
export function VendorHistoryModal({
  vendorCode,
  productCode,
  onClose,
}: {
  vendorCode: string;
  productCode?: string | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<VendorPoHistory | null>(null);
  // `loaded` rather than a `loading` flag set on the way in: setting state synchronously
  // inside an effect is a cascading render, so the state only moves in the callback.
  const [loaded, setLoaded] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setHost(document.body), 0);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    let alive = true;
    void getVendorPoHistory(vendorCode, productCode ?? null)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setLoaded(true);
      })
      .catch(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [vendorCode, productCode]);

  if (!host) return null;
  // With a product in scope, "last PO" means their last PO OF THAT PRODUCT (spec 7.8).
  // Opened from a vendor page, where no product is in scope, it means their last PO at all —
  // a dash there would just look like missing data.
  const last = productCode ? (data?.lastSameProduct ?? null) : (data?.lastAny ?? null);

  return createPortal(
    <div className="pc-backdrop" role="dialog" aria-modal="true" aria-label={`History for ${vendorCode}`}>
      <div className="pc-modal">
        <div className="pc-head">
          <div>
            <span className="panel-kicker">Vendor history</span>
            <h3>
              {data?.vendorCode ?? vendorCode.toUpperCase()}
              {data?.vendorName ? ` · ${data.vendorName}` : ''}
            </h3>
            <p className="wf-subtle">
              Completed POs only, newest first. Days are counted from the PO date to the day EasyCom last
              updated it — the same basis as the TNA comparison on the submission pop-up.
            </p>
          </div>
          <button type="button" className="wf-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <section className="pc-section">
          <div className="wf-kpi-strip">
            <div className="wf-kpi">
              <span className="wf-kpi-label">
                Last PO{productCode ? ` · ${productCode}` : ''}
              </span>
              <strong className="wf-kpi-value">{last ? `${last.days}d` : '—'}</strong>
            </div>
            <div className="wf-kpi">
              <span className="wf-kpi-label">Average · all POs</span>
              <strong className="wf-kpi-value">{data?.averageDays != null ? `${data.averageDays}d` : '—'}</strong>
            </div>
            <div className="wf-kpi">
              <span className="wf-kpi-label">POs completed</span>
              <strong className="wf-kpi-value">{data?.totalPos ?? 0}</strong>
            </div>
            <div className="wf-kpi">
              <span className="wf-kpi-label">Finished by the promised date</span>
              <strong className="wf-kpi-value">{data?.onTimePct != null ? `${data.onTimePct}%` : '—'}</strong>
            </div>
            <p className="wf-kpi-note">
              {last ? (
                <>
                  Last {productCode ?? 'PO'}: <strong>{last.poRef}</strong>
                  {!productCode && last.products.length ? ` (${last.products.join(', ')})` : ''}, {day(last.start)} →{' '}
                  {day(last.done)}.
                </>
              ) : productCode ? (
                <>
                  This vendor has never completed a PO of <strong>{productCode}</strong>
                  {data?.lastAny ? (
                    <>
                      {' '}
                      — their most recent PO was {data.lastAny.poRef} at {data.lastAny.days}d.
                    </>
                  ) : (
                    '.'
                  )}
                </>
              ) : (
                'No completed PO on record for this vendor.'
              )}
            </p>
          </div>
        </section>

        <section className="pc-section">
          <div className="table-scroll" style={{ maxHeight: 340 }}>
            <table className="wf-grid">
              <thead>
                <tr>
                  <th>PO</th>
                  <th>Product</th>
                  <th className="num">Qty</th>
                  <th>Raised</th>
                  <th>Completed</th>
                  <th className="num">Days</th>
                  <th>Against EDD</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((r) => (
                  <tr
                    key={r.poRef}
                    className={productCode && r.products.includes(productCode) ? 'wf-row-dirty' : undefined}
                  >
                    <td className="mono">
                      {r.poRef}
                      {r.poNumber && <small className="wf-subtle">EasyCom {r.poNumber}</small>}
                    </td>
                    <td className="mono">{r.products.join(', ') || '—'}</td>
                    <td className="num">{n0.format(r.qty)}</td>
                    <td>{day(r.start)}</td>
                    <td>{day(r.done)}</td>
                    <td className="num">
                      <strong>{r.days}</strong>
                    </td>
                    <td>
                      <Late days={r.lateDays} />
                      {r.edd && <small className="wf-subtle">due {day(r.edd)}</small>}
                    </td>
                  </tr>
                ))}
                {loaded && !data?.rows.length && (
                  <tr>
                    <td colSpan={7} className="wf-empty-cell">
                      No completed POs for this vendor yet.
                    </td>
                  </tr>
                )}
                {!loaded && (
                  <tr>
                    <td colSpan={7} className="wf-empty-cell">
                      Reading this vendor’s POs…
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {productCode && data?.rows.some((r) => r.products.includes(productCode)) && (
            <p className="wf-subtle">Highlighted rows are POs of {productCode}.</p>
          )}
        </section>

        <div className="pc-foot">
          <button type="button" className="wf-btn wf-btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}

/** The button that opens the history, with the modal it owns. */
export function VendorHistoryButton({
  vendorCode,
  productCode,
  label = 'Vendor history',
  className = 'wf-btn wf-btn-ghost wf-btn-sm',
}: {
  vendorCode: string | null | undefined;
  productCode?: string | null;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const code = (vendorCode ?? '').trim();
  if (!code) return null;
  return (
    <>
      <button
        type="button"
        className={className}
        onClick={() => setOpen(true)}
        title={`How long ${code.toUpperCase()} has taken, PO by PO`}
      >
        <History size={13} /> {label}
      </button>
      {open && (
        <VendorHistoryModal vendorCode={code} productCode={productCode} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
