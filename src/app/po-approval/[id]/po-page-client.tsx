'use client';

import Link from 'next/link';
import { FilePen } from 'lucide-react';
import { canEdit } from '@/lib/forms/approval';
import { StatusBadge } from '@/components/forms/form-layout';
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
    { k: 'EasyEcom PO', v: po.easycom_po_no ?? 'not yet' },
    { k: 'EasyEcom reference', v: po.po_ref_num?.trim() || 'Not provided' },
    { k: 'First delivery', v: po.critical_path_first_delivery ? dayLabel(po.critical_path_first_delivery) : '—' },
  ];

  return (
    <>
      <section className="panel poa-head">
        <div className="poa-head-top">
          <div className="poa-head-title">
            <span className="mono poa-head-id">{po.request_id}</span>
            <StatusBadge status={po.status} approverEdited={po.approver_edited} />
            <span className={`poa-flag is-${flag.tone}`} title={flag.title}>{flag.text}</span>
          </div>
          <div className="poa-head-controls">
            <StageStrip po={po} large />
            {po.status === 'draft' && canEdit(role, po.status) && (
              <Link className="wf-btn wf-btn-primary poa-edit-request" href={`/po-approval?edit=${po.id}`}>
                <FilePen size={14} /> Edit PO Request
              </Link>
            )}
          </div>
        </div>
        <dl className="poa-facts">
          {facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>

        <section className={`poa-nextstep is-${step.who}`}>
          {step.who !== 'you' && (
            <div className="poa-nextstep-kicker">
              {step.who === 'other' ? 'Waiting on someone else' : 'Where it stands'}
            </div>
          )}
          <h3>{step.title}</h3>
          {step.detail && <p>{step.detail}</p>}
          {step.who === 'you' && step.focus === 'cost' && (
            <a className="wf-btn wf-btn-primary wf-btn-sm poa-nextstep-go" href={`/po-approval?edit=${po.id}`}>Open the form</a>
          )}
        </section>

        <div className="poa-page-body">
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
            reviewAlways
          />
        </div>
      </section>


    </>
  );
}
