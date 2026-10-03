'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { CalendarCheck } from 'lucide-react';
import { InfoDot } from '@/components/info-dot';
import { confirmTna } from '@/lib/forms/actions';
import { canApprove } from '@/lib/forms/approval';
import { reloadWithToast, toastError } from '@/lib/toast';
import { utilisationLabel } from '@/lib/utilisation';
import type { ApprovalQueueItem, SdRole } from '@/lib/forms/types';

/**
 * The four things an approver verifies on a PO — Stock, Cost, TNA, Vendor — as four panels,
 * each with the headline figure first, a verdict, and the numbers behind it. Rendered on the
 * Approvals queue card and on the PO Approval page's own card, from the same queue item, so
 * the two never disagree.
 */
const fmtNum = (v: number | null | undefined) =>
  v == null ? '—' : v.toLocaleString('en-IN');
const fmtDate = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleDateString('en-IN') : '—';

/**
 * The inline "4 things the approver verifies" panel on a PO approval card — expands
 * the one-line entry into tabs (Inventory / Standard Cost / TNA / Vendor) so the
 * whole review happens without leaving the queue.
 */
/** A small verdict chip: green when the check passes, red when it is worth a look. */
/**
 * The approver confirms the TNA dates right on the card — approval is blocked until they
 * do, and sending them to the PO page for one click was the complaint. The dates arrive
 * pre-filled from the PO; an edit here is stored the same way the PO page stores it
 * (converted to day counts against the PO's base, see confirmTna).
 */
function TnaConfirm({ poId, tna }: { poId: string; tna: NonNullable<ApprovalQueueItem['poDetail']>['tna'] }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const day = (v: string | null) => (v ? String(v).slice(0, 10) : '');
  const [dates, setDates] = useState({
    cs_pp_sample_due: day(tna.ppSampleDue),
    cs_gpt_due: day(tna.gptDue),
    cs_cutting_start: day(tna.cuttingStart),
    cs_inline_qc_due: day(tna.inlineQcDue),
    critical_path_first_delivery: day(tna.firstDelivery),
    po_closing_date: day(tna.poClosingDate),
  });
  const set = (k: keyof typeof dates, v: string) => setDates((d) => ({ ...d, [k]: v }));
  const fields: { key: keyof typeof dates; label: string }[] = [
    { key: 'cs_pp_sample_due', label: 'PP sample due' },
    { key: 'cs_gpt_due', label: 'GPT due' },
    { key: 'cs_cutting_start', label: 'Cutting start' },
    { key: 'cs_inline_qc_due', label: 'Inline QC due' },
    { key: 'critical_path_first_delivery', label: 'First delivery' },
    { key: 'po_closing_date', label: 'PO closing' },
  ];
  function confirm() {
    setError(null);
    const fd = new FormData();
    fd.set('id', poId);
    for (const [k, v] of Object.entries(dates)) fd.set(k, v);
    start(async () => {
      const r = await confirmTna(fd);
      if (r.ok) reloadWithToast(r.message ?? 'TNA dates confirmed.');
      else setError(toastError(r.error));
    });
  }
  return (
    <div className="wf-tna-confirm">
      <p className="wf-subtle">
        Approval is blocked until the dates are confirmed. Check them, adjust if needed, and confirm here.
      </p>
      <div className="wf-tna-confirm-grid">
        {fields.map((f) => (
          <label key={f.key} className="wf-tna-confirm-field">
            <span>{f.label}</span>
            <input type="date" value={dates[f.key]} onChange={(e) => set(f.key, e.target.value)} disabled={pending} />
          </label>
        ))}
      </div>
      {error && <p className="wf-inline-error">{error}</p>}
      <button type="button" className="wf-btn wf-btn-primary wf-btn-sm" onClick={confirm} disabled={pending}>
        <CalendarCheck size={13} /> {pending ? 'Confirming…' : 'Confirm TNA dates'}
      </button>
    </div>
  );
}

function Verdict({ ok, text }: { ok: boolean | null; text: string }) {
  return <span className={`wf-verdict ${ok == null ? 'is-none' : ok ? 'is-ok' : 'is-flag'}`}>{text}</span>;
}

/**
 * The four things an approver verifies on a PO — Stock, Cost, TNA, Vendor — as four panels
 * that are always visible, each with the headline figure first, a verdict, and the numbers
 * behind it. Nothing hides behind a button: the card is the review.
 */
export function PoReviewPanels({ item, role }: { item: ApprovalQueueItem; role: SdRole }) {
  const d = item.poDetail!;
  const std = d.stdCost;
  const stdForType = std
    ? d.poType === 'job_work'
      ? std.job
      : d.poType === 'efob'
        ? std.efob
        : std.fob
    : null;
  const variance = d.writtenRate != null && stdForType != null ? d.writtenRate - stdForType : null;
  const cmDelta = d.poCm != null && d.stdCm != null ? d.poCm - d.stdCm : null;
  const fabricDelta =
    d.poFinishedFabric != null && d.stdFinishedFabric != null ? d.poFinishedFabric - d.stdFinishedFabric : null;
  const inproc = item.vendorInProcessQty ?? null;
  const cap = item.vendorPoCapacity ?? null;
  const headroom = cap != null && inproc != null ? cap - inproc : null;
  const util = item.vendorCapacityUtil ?? null;
  const utilWithPo = cap && cap > 0 && inproc != null ? Math.round(((inproc + d.poQty) / cap) * 1000) / 10 : null;
  const days = d.inventory?.daysOfStock ?? null;
  const typeLabel = d.poType === 'job_work' ? 'Job Work' : d.poType === 'efob' ? 'E-FOB' : d.poType ? 'FOB' : '—';

  return (
    <div className="wf-verify-grid">
      {/* ---- Stock */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Stock <InfoDot text={"WHAT: does this product need the pieces on this PO.\n\nHOW: from the nightly inventory snapshot: stock on hand, pieces already on order, and the 45-day daily demand. Days of stock = stock ÷ daily demand.\n\nUSE: plenty of days of stock and plenty on order → ask why the PO is needed now."} />
          </h4>
          {d.inventory ? (
            <Verdict ok={days == null ? null : days < 45} text={days == null ? 'no demand' : days < 45 ? `${days} days of stock` : `${days} days of stock`} />
          ) : (
            <Verdict ok={null} text="no snapshot" />
          )}
        </div>
        {d.inventory ? (
          <dl>
            <div><dt>In stock</dt><dd>{fmtNum(d.inventory.currentStock)} pcs</dd></div>
            <div><dt>Already on order</dt><dd>{fmtNum(d.inventory.inProgress)} pcs</dd></div>
            <div><dt>Sells a day</dt><dd>{d.inventory.doq45}</dd></div>
            <div><dt>This PO adds</dt><dd>{fmtNum(d.poQty)} pcs</dd></div>
          </dl>
        ) : (
          <p className="wf-subtle">No inventory snapshot for {d.productCode ?? 'this product'}.</p>
        )}
      </section>

      {/* ---- Cost */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Cost <InfoDot text={"WHAT: is the rate on this PO above the approved Standard Cost.\n\nHOW: written rate − standard for this PO type. CM (cut-make) is shown against standard CM because that is what the vendor controls; grey and finished fabric are commodity and move with the market — informational.\n\nUSE: above standard needs a reason (the submitter's remark is at the top of the card); the Standard Cost link opens the negotiation record."} />
          </h4>
          <Verdict
            ok={variance == null ? null : variance <= 0.005}
            text={variance == null ? 'no standard' : variance > 0.005 ? `₹${fmtNum(variance)} above standard` : 'at or below standard'}
          />
        </div>
        <dl>
          <div><dt>Rate on PO</dt><dd><strong>₹{fmtNum(d.writtenRate)}</strong></dd></div>
          <div><dt>Standard ({typeLabel})</dt><dd>{stdForType != null ? `₹${fmtNum(stdForType)}` : 'not approved'}</dd></div>
          <div>
            <dt>CM vs standard</dt>
            <dd className={cmDelta != null && cmDelta > 0 ? 'wf-error-text' : undefined}>
              ₹{fmtNum(d.poCm)} vs {d.stdCm != null ? `₹${fmtNum(d.stdCm)}` : '—'}
              {cmDelta != null && cmDelta > 0 ? ` (+${fmtNum(cmDelta)})` : ''}
            </dd>
          </div>
          <div>
            <dt>Fabric vs std <small>commodity</small></dt>
            <dd className="wf-subtle">
              ₹{fmtNum(d.poFinishedFabric)} vs {d.stdFinishedFabric != null ? `₹${fmtNum(d.stdFinishedFabric)}` : '—'}
              {fabricDelta != null && fabricDelta !== 0 ? ` (${fabricDelta > 0 ? '+' : ''}${fmtNum(fabricDelta)})` : ''}
            </dd>
          </div>
        </dl>
        {d.productCode && (
          <Link className="wf-verify-link" href={`/standard-cost/${encodeURIComponent(d.productCode)}`}>
            Open Standard Cost →
          </Link>
        )}
      </section>

      {/* ---- TNA */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            TNA <InfoDot text={"WHAT: the production timeline the PO commits to.\n\nHOW: the critical-path dates as entered — PP sample, GPT, cutting, inline QC, first delivery, closing — and the days from submission to first delivery. 'Confirmed' means an approver has locked the dates; cost cannot be approved before that.\n\nUSE: compare the requested days with what this vendor actually takes (Vendor Performance → OTIF scorecard)."} />
          </h4>
          <Verdict ok={d.tna.tnaConfirmed} text={d.tna.tnaConfirmed ? 'dates confirmed' : 'dates not confirmed'} />
        </div>
        <dl>
          <div><dt>Days to delivery</dt><dd><strong>{d.tna.requestedTotalDays ?? '—'}</strong></dd></div>
          <div><dt>First delivery</dt><dd>{fmtDate(d.tna.firstDelivery)}</dd></div>
          <div><dt>PP sample · GPT</dt><dd>{fmtDate(d.tna.ppSampleDue)} · {fmtDate(d.tna.gptDue)}</dd></div>
          <div><dt>Cutting · Inline QC</dt><dd>{fmtDate(d.tna.cuttingStart)} · {fmtDate(d.tna.inlineQcDue)}</dd></div>
          <div><dt>PO closing</dt><dd>{fmtDate(d.tna.poClosingDate)}</dd></div>
        </dl>
        {!d.tna.tnaConfirmed && canApprove(role, item.status) && (
          <TnaConfirm poId={item.entityId} tna={d.tna} />
        )}
      </section>

      {/* ---- Vendor */}
      <section className="wf-verify-card">
        <div className="wf-verify-head">
          <h4>
            Vendor <InfoDot text={"WHAT: can the vendor take this PO on top of what they already have.\n\nHOW: PO capacity = what the vendor can make inside this PO type's lead time (the one capacity model, from the Vendor Capacity sheet and Rules Master). Headroom = PO capacity − pieces already in process. 'With this PO' = (in process + this PO) ÷ PO capacity.\n\nUSE: past 100% with this PO, something will be late — decide which."} />
          </h4>
          {cap == null ? (
            <Verdict ok={null} text="capacity not entered" />
          ) : (
            <Verdict ok={utilWithPo != null && utilWithPo <= 100} text={utilWithPo != null ? `${utilisationLabel(utilWithPo)} with this PO` : '—'} />
          )}
        </div>
        <dl>
          <div><dt>In process</dt><dd>{inproc == null ? 'no open POs' : `${fmtNum(inproc)} pcs`}{util != null ? <small className="wf-subtle"> · {utilisationLabel(util)} of PO capacity</small> : null}</dd></div>
          <div><dt>PO capacity ({item.vendorLeadDays ?? '—'}-day lead)</dt><dd>{cap == null ? 'not entered' : `${fmtNum(cap)} pcs`}</dd></div>
          <div><dt>Headroom</dt><dd className={headroom != null && headroom < d.poQty ? 'wf-error-text' : undefined}>{headroom != null ? `${fmtNum(headroom)} pcs` : '—'}{headroom != null && headroom < d.poQty ? ' — less than this PO' : ''}</dd></div>
          <div><dt>Capacity / month</dt><dd>{item.vendorCapacityPerMonth != null ? `${fmtNum(item.vendorCapacityPerMonth)} pcs` : '—'}{item.vendorCapacityUpdatedAt ? ` · ${fmtDate(item.vendorCapacityUpdatedAt)}` : ''}</dd></div>
        </dl>
      </section>
    </div>
  );
}

