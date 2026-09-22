'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, X } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import type { PoSubmissionChecks } from '@/lib/forms/queries-modules/po-checks';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const rs = (v: number | null | undefined) => (v == null ? '—' : `₹${inr.format(Math.round(v * 100) / 100)}`);
const day = (iso: string | null | undefined) =>
  iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '—';

/** "+₹5 (2.5%) more" / "₹3 less" / "same" — the difference of the PO figure against a reference. */
function Delta({ po, against: r, unit = '₹' }: { po: number | null; against: number | null; unit?: string }) {
  if (po == null || r == null) return <span className="pc-delta is-none">no comparison</span>;
  const d = po - r;
  if (Math.abs(d) < 0.005) return <span className="pc-delta is-same">same</span>;
  const pctv = r ? Math.round((Math.abs(d) / r) * 1000) / 10 : null;
  const txt = unit === '₹' ? rs(Math.abs(d)) : `${inr.format(Math.abs(d))}${unit}`;
  return (
    <span className={`pc-delta ${d > 0 ? 'is-up' : 'is-down'}`}>
      {d > 0 ? '+' : '−'}{txt}{pctv != null ? ` (${pctv}%)` : ''} {d > 0 ? 'more' : 'less'}
    </span>
  );
}

/**
 * Spec 7.1 — the pop-up before a PO is submitted. Three validations (cost, TNA, quantity),
 * each a comparison the submitter must look at, a remark, and whether the product is in the
 * buying plan. Nothing blocks; the point is that "why more?" is asked before, not after.
 */
export function SubmitChecksModal({
  checks: c,
  pending,
  onConfirm,
  onCancel,
}: {
  checks: PoSubmissionChecks;
  pending: boolean;
  onConfirm: (remark: string) => void;
  onCancel: () => void;
}) {
  const [remark, setRemark] = useState('');
  // Rendered into <body>: the modal is opened from inside a table row, where a <div> is not allowed.
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => setHost(document.body), 0);
    return () => window.clearTimeout(t);
  }, []);
  const costUp = c.cost.written != null && c.cost.standard != null && c.cost.written > c.cost.standard + 0.005;
  const cmUp = c.cost.cm.po != null && c.cost.cm.standard != null && c.cost.cm.po > c.cost.cm.standard + 0.005;
  const tnaShort =
    c.tna.requestedDays != null &&
    ((c.tna.vendorFyAvg && c.tna.requestedDays < c.tna.vendorFyAvg.days) || (c.tna.vendorLastPo && c.tna.requestedDays < c.tna.vendorLastPo.days));
  const qtyOver = c.quantity.replenishment != null && c.quantity.poQty > c.quantity.replenishment.neededQty;
  const capOver = c.quantity.capacity?.entered && c.quantity.capacity.utilWithThisPo != null && c.quantity.capacity.utilWithThisPo > 100;
  const flags = [costUp, cmUp, tnaShort, qtyOver, capOver].filter(Boolean).length;

  if (!host) return null;
  return createPortal(
    <div className="pc-backdrop" role="dialog" aria-modal="true" aria-label="Check before submitting">
      <div className="pc-modal">
        <div className="pc-head">
          <div>
            <span className="panel-kicker">Before you submit</span>
            <h3>
              {c.poRef ?? 'This PO'} · {c.productCode ?? '—'} · {c.poTypeLabel} · {inr.format(c.qty)} pcs
            </h3>
            <p className="wf-subtle">
              {flags ? `${flags} thing${flags === 1 ? '' : 's'} worth a second look — say why in the remark.` : 'Nothing stands out. Add a remark if the approver should know something.'}
            </p>
          </div>
          <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={onCancel} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* ---------------- (a) Cost */}
        <section className={`pc-section${costUp || cmUp ? ' is-flag' : ''}`}>
          <h4>
            {(costUp || cmUp) && <AlertTriangle size={14} />} Cost
            <InfoDot text={"WHAT: the rate written on this PO against three references — the approved Standard Cost, the last PO for this product and type, and the cheapest ever paid for it.\n\nHOW: rates are compared per piece for the same PO type only (a Job Work rate is not comparable with a FOB rate). CM (cut-make) and fabric are shown apart: CM is what the vendor controls; fabric is a commodity and moves with the market.\n\nUSE: if the PO is above standard, the approver will ask why — say it here first."} />
          </h4>
          <table className="pc-table">
            <tbody>
              <tr>
                <th>Rate on this PO</th>
                <td className="num"><strong>{rs(c.cost.written)}</strong></td>
                <td />
              </tr>
              <tr>
                <th>Standard Cost ({c.poTypeLabel})</th>
                <td className="num">{rs(c.cost.standard)}</td>
                <td><Delta po={c.cost.written} against={c.cost.standard} /></td>
              </tr>
              <tr>
                <th>
                  Last PO for this product
                  {c.cost.lastPo ? <small className="wf-subtle"> · {c.cost.lastPo.poRef} · {c.cost.lastPo.vendor ?? '—'} · {day(c.cost.lastPo.date)}</small> : null}
                </th>
                <td className="num">{c.cost.lastPo ? rs(c.cost.lastPo.rate) : <span className="wf-subtle">none on record</span>}</td>
                <td><Delta po={c.cost.written} against={c.cost.lastPo?.rate ?? null} /></td>
              </tr>
              <tr>
                <th>
                  Cheapest ever for this product
                  {c.cost.cheapest ? <small className="wf-subtle"> · {c.cost.cheapest.poRef} · {c.cost.cheapest.vendor ?? '—'} · {day(c.cost.cheapest.date)}</small> : null}
                </th>
                <td className="num">{c.cost.cheapest ? rs(c.cost.cheapest.rate) : <span className="wf-subtle">none on record</span>}</td>
                <td><Delta po={c.cost.written} against={c.cost.cheapest?.rate ?? null} /></td>
              </tr>
              <tr className="pc-sub">
                <th>CM on this PO vs standard CM <small className="wf-subtle">· what the vendor controls</small></th>
                <td className="num">{rs(c.cost.cm.po)} <span className="wf-subtle">vs {rs(c.cost.cm.standard)}</span></td>
                <td><Delta po={c.cost.cm.po} against={c.cost.cm.standard} /></td>
              </tr>
              <tr className="pc-sub">
                <th>Fabric on this PO vs standard fabric <small className="wf-subtle">· commodity, informational</small></th>
                <td className="num">{rs(c.cost.fabric.po)} <span className="wf-subtle">vs {rs(c.cost.fabric.standard)}</span></td>
                <td><Delta po={c.cost.fabric.po} against={c.cost.fabric.standard} /></td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* ---------------- (b) TNA */}
        <section className={`pc-section${tnaShort ? ' is-flag' : ''}`}>
          <h4>
            {tnaShort && <AlertTriangle size={14} />} TNA — time to first delivery
            <InfoDot text={"WHAT: the days you are giving this PO against what the type normally takes, what this vendor actually took last time, and what they average this financial year.\n\nHOW: requested days = first delivery date − today. Vendor days = completion date − PO date on their completed POs (financial year from 1 April). Rule days come from Rules Master per PO type.\n\nUSE: a vendor who always takes 50 days will not do it in 30 because the PO says so — either give the real days or say why this one is different."} />
          </h4>
          <table className="pc-table">
            <tbody>
              <tr>
                <th>Requested on this PO</th>
                <td className="num"><strong>{c.tna.requestedDays == null ? '—' : `${c.tna.requestedDays} days`}</strong></td>
                <td><span className="wf-subtle">first delivery {day(c.tna.firstDelivery)}</span></td>
              </tr>
              <tr>
                <th>Lead time mapped to {c.poTypeLabel} (Rules Master)</th>
                <td className="num">{c.tna.ruleDays} days</td>
                <td><Delta po={c.tna.requestedDays} against={c.tna.ruleDays} unit="d" /></td>
              </tr>
              <tr>
                <th>
                  This vendor&apos;s last PO — actual
                  {c.tna.vendorLastPo ? <small className="wf-subtle"> · {c.tna.vendorLastPo.poRef} · {c.tna.vendorLastPo.product ?? '—'} · done {day(c.tna.vendorLastPo.date)}</small> : null}
                </th>
                <td className="num">{c.tna.vendorLastPo ? `${c.tna.vendorLastPo.days} days` : <span className="wf-subtle">no completed PO</span>}</td>
                <td><Delta po={c.tna.requestedDays} against={c.tna.vendorLastPo?.days ?? null} unit="d" /></td>
              </tr>
              <tr>
                <th>
                  This vendor&apos;s average this financial year
                  {c.tna.vendorFyAvg ? <small className="wf-subtle"> · {c.tna.vendorFyAvg.pos} POs since {day(c.tna.vendorFyAvg.fyStart)}</small> : null}
                </th>
                <td className="num">{c.tna.vendorFyAvg ? `${c.tna.vendorFyAvg.days} days` : <span className="wf-subtle">none this year</span>}</td>
                <td><Delta po={c.tna.requestedDays} against={c.tna.vendorFyAvg?.days ?? null} unit="d" /></td>
              </tr>
              <tr>
                <th>
                  Last PO of this product, any vendor
                  {c.tna.lastPoSameProduct ? <small className="wf-subtle"> · {c.tna.lastPoSameProduct.poRef} · {c.tna.lastPoSameProduct.vendor ?? '—'}</small> : null}
                </th>
                <td className="num">{c.tna.lastPoSameProduct?.days != null ? `${c.tna.lastPoSameProduct.days} days` : <span className="wf-subtle">none on record</span>}</td>
                <td><Delta po={c.tna.requestedDays} against={c.tna.lastPoSameProduct?.days ?? null} unit="d" /></td>
              </tr>
            </tbody>
          </table>
          <div className="pc-path">
            {c.tna.stages.map((s) => (
              <span key={s.label} className={`pc-stage${s.date ? '' : ' is-empty'}`}>
                <b>{s.label}</b>
                <small>{day(s.date)}</small>
              </span>
            ))}
          </div>
        </section>

        {/* ---------------- (c) Quantity */}
        <section className={`pc-section${qtyOver || capOver ? ' is-flag' : ''}`}>
          <h4>
            {(qtyOver || capOver) && <AlertTriangle size={14} />} Quantity
            <InfoDot text={"WHAT: the PO quantity against what the product needs and what the vendor can make.\n\nHOW: Needed = Replenishment's reorder quantity for the horizon at or above this PO type's lead time (Job Work → 30-day, E-FOB → 60-day, FOB → 90-day reorder): pieces to stay in stock through the lead time, net of stock and what is already on order. Vendor capacity = the one capacity model for this PO type, with this PO added to the vendor's in-process load.\n\nUSE: a PO well above the need ties up cash; a vendor pushed past PO capacity will be late. The rule that PO quantity must be the lower is not enforced yet (deferred until Replenishment is built out) — it is shown so the choice is deliberate."} />
          </h4>
          <table className="pc-table">
            <tbody>
              <tr>
                <th>On this PO</th>
                <td className="num"><strong>{inr.format(c.quantity.poQty)} pcs</strong></td>
                <td />
              </tr>
              {c.quantity.replenishment ? (
                <>
                  <tr>
                    <th>Needed to cover {c.quantity.replenishment.horizonDays} days (Replenishment)</th>
                    <td className="num">{inr.format(c.quantity.replenishment.neededQty)} pcs</td>
                    <td><Delta po={c.quantity.poQty} against={c.quantity.replenishment.neededQty} unit=" pcs" /></td>
                  </tr>
                  <tr className="pc-sub">
                    <th>Product today</th>
                    <td className="num" colSpan={2}>
                      {inr.format(c.quantity.replenishment.currentStock)} in stock · {inr.format(c.quantity.replenishment.inProgress)} already on order · sells{' '}
                      {Math.round(c.quantity.replenishment.dailyDemand * 10) / 10} a day
                    </td>
                  </tr>
                </>
              ) : (
                <tr>
                  <th>Needed (Replenishment)</th>
                  <td colSpan={2}><span className="wf-subtle">product not on the replenishment feed</span></td>
                </tr>
              )}
              {c.quantity.capacity ? (
                c.quantity.capacity.entered ? (
                  <>
                    <tr>
                      <th>Vendor PO capacity ({c.quantity.capacity.leadDays}-day lead)</th>
                      <td className="num">{inr.format(c.quantity.capacity.poCapacity)} pcs</td>
                      <td>
                        <span className={`pc-delta ${capOver ? 'is-up' : 'is-down'}`}>
                          {c.quantity.capacity.utilWithThisPo}% used with this PO
                        </span>
                      </td>
                    </tr>
                    <tr className="pc-sub">
                      <th>Vendor today</th>
                      <td className="num" colSpan={2}>
                        {inr.format(c.quantity.capacity.inProcess)} pcs in process · {c.quantity.capacity.available == null ? '—' : `${inr.format(c.quantity.capacity.available)} pcs free`}
                        {c.quantity.capacity.updatedAt ? ` · capacity entered ${new Date(c.quantity.capacity.updatedAt).toLocaleDateString('en-IN')}` : ''}
                      </td>
                    </tr>
                  </>
                ) : (
                  <tr>
                    <th>Vendor PO capacity</th>
                    <td colSpan={2}><span className="wf-subtle">not entered on Vendor Capacity</span></td>
                  </tr>
                )
              ) : null}
            </tbody>
          </table>
        </section>

        {/* ---------------- plan + remark */}
        <section className="pc-section">
          <p className="pc-plan">
            {c.plan.inPlan ? (
              <>
                <Check size={14} /> <strong>In the {c.plan.planMonth.slice(0, 7)} buying plan</strong> — approved {inr.format(c.plan.qty.total)} pcs
              </>
            ) : (
              <>
                <AlertTriangle size={14} /> <strong>Not in the {c.plan.planMonth.slice(0, 7)} buying plan</strong>
                {c.plan.linePresent ? ' (listed, no approved quantity)' : c.plan.planExists ? '' : ' (no plan for that month)'} — an ad-hoc purchase
              </>
            )}
          </p>
          <label className="pc-remark">
            <span>Remark for the approver {flags ? <em>— say why, since something stands out</em> : <em>(optional)</em>}</span>
            <textarea className="wf-textarea" rows={3} value={remark} placeholder="e.g. Standard cost is out of date — fabric moved ₹12 this month; vendor confirmed 40 days in writing." onChange={(e) => setRemark(e.target.value)} />
          </label>
        </section>

        <div className="pc-foot">
          <button type="button" className="wf-btn wf-btn-ghost" onClick={onCancel} disabled={pending}>
            Back — keep as draft
          </button>
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={() => onConfirm(remark.trim())}
            disabled={pending || (flags > 0 && !remark.trim())}
            title={flags > 0 && !remark.trim() ? 'Something stands out — add a remark first' : undefined}
          >
            <Check size={14} /> {pending ? 'Submitting…' : 'Confirm & submit for approval'}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
