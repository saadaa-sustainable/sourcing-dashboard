'use client';

import { StatusBadge } from '@/components/forms/form-layout';
import { InfoDot } from '@/components/info-dot';
import { PoCardBody, StageStrip, dateOnly, dayLabel, inr, nextStep, nfmt, poFlag, typeLabel } from '../po-card';
import type { ApprovalQueueItem, PoApproval, PoApprovalLine, PoCycleTime, PoDeleteRequest, SdRole } from '@/lib/forms/types';

/**
 * The PO's own page: a header that says where it stands, a "what happens next" panel that
 * says whose move it is, then the review and the actions (the same body as the list card,
 * with the SKU lines and the full record open).
 */
export function PoPageClient({
  po,
  cycle,
  lines,
  deleteRequest,
  review,
  stdCm = {},
  role,
}: {
  po: PoApproval;
  cycle?: PoCycleTime;
  lines: PoApprovalLine[];
  deleteRequest?: PoDeleteRequest;
  review?: ApprovalQueueItem;
  stdCm?: Record<string, number>;
  role: SdRole;
}) {
  const stdCmForPo = po.product_code ? stdCm[po.product_code.trim()] : undefined;
  const flag = poFlag(po, { deleteRequest, review, stdCm: stdCmForPo, role });
  const step = nextStep(po, role, lines, deleteRequest);
  const qty = Number(po.po_qty || 0);
  const value = po.rate != null ? qty * Number(po.rate) : null;
  const facts: { k: string; v: string }[] = [
    { k: 'PO type', v: typeLabel(po) },
    { k: 'Pieces', v: qty ? nfmt(qty) : 'no SKU lines yet' },
    { k: 'Rate', v: po.rate != null ? `₹${nfmt(Number(po.rate))} / pc` : 'not set' },
    { k: 'Value', v: value != null ? inr(value) : '—' },
    { k: 'Raised', v: `${dayLabel(dateOnly(po.timestamp_created ?? po.created_at))}${po.created_by ? ` · ${po.created_by}` : ''}` },
    { k: 'Buying plan', v: po.in_buying_plan === true ? `in the ${po.buying_plan_no ?? ''} plan` : po.in_buying_plan === false ? `ad-hoc${po.ad_hoc_reason ? ` — ${po.ad_hoc_reason}` : ''}` : po.buying_plan_no ?? '—' },
    { k: 'EasyCom PO', v: po.easycom_po_no ?? 'not yet' },
    { k: 'First delivery', v: po.critical_path_first_delivery ? dayLabel(po.critical_path_first_delivery) : '—' },
  ];

  return (
    <>
      <section className="panel poa-head">
        <div className="poa-head-top">
          <div className="poa-head-title">
            <span className="mono poa-head-id">{po.request_id}</span>
            <StatusBadge status={po.status} />
            <span className={`poa-flag is-${flag.tone}`} title={flag.title}>{flag.text}</span>
          </div>
          <StageStrip po={po} large />
        </div>
        <dl className="poa-facts">
          {facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={`panel poa-nextstep is-${step.who}`}>
        <div className="poa-nextstep-kicker">
          {step.who === 'you' ? 'Your move' : step.who === 'other' ? 'Waiting on someone else' : 'Where it stands'}
          <InfoDot text={"WHAT: the next thing that has to happen to this PO, and whose move it is.\n\nHOW: from the PO's status, what it still lacks (cost, SKU lines, confirmed TNA dates, an EasyCom PO number), and your role.\n\nUSE: do what it says — the controls for it are right below."} />
        </div>
        <h3>{step.title}</h3>
        {step.detail && <p>{step.detail}</p>}
      </section>

      <section className="panel poa-page-body">
        <PoCardBody
          po={po}
          cycle={cycle}
          lines={lines}
          role={role}
          deleteRequest={deleteRequest}
          review={review}
          stdCm={stdCm}
          editHref={`/po-approval?edit=${po.id}`}
          defaultLinesOpen
          defaultDetailOpen
          reviewAlways
        />
      </section>
    </>
  );
}
