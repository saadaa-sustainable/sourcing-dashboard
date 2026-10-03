'use client';

import { FileDown } from 'lucide-react';
import { VendorHistoryButton } from '@/components/vendor-history-modal';
import { addTnaDays, tnaBaseFor } from '@/lib/business-logic';
import { STATUS_LABEL } from '@/lib/forms/approval';
import type { PoApproval, PoApprovalLine, PoCycleTime } from '@/lib/forms/types';

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

const day = (iso: string | null | undefined) =>
  iso
    ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '—';

/** A timestamp as the IST date and time it happened. */
const stamp = (ts: string | null | undefined) =>
  ts
    ? new Date(ts).toLocaleString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const money = (v: number | null | undefined) => (v == null ? '—' : `₹${inr.format(Number(v))}`);
const text = (v: string | null | undefined) => (v && String(v).trim() ? String(v) : '—');
const yesNo = (v: boolean | null | undefined) => (v ? 'Yes' : 'No');

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Link({ href, label = 'Open' }: { href: string | null | undefined; label?: string }) {
  if (!href || !href.trim()) return <>—</>;
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {label}
    </a>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="wf-po-detail-block">
      <span className="wf-cost-param-head">{title}</span>
      <dl className="wf-doc-meta">{children}</dl>
    </section>
  );
}

/**
 * Everything a PO request carries, read-only — opened by clicking its row.
 *
 * Nothing here is editable on purpose: this is the record of what was submitted and what
 * has happened to it since. Editing stays behind Edit (and only until submission), so
 * reading a PO can never change one.
 */
export function PoDetailPanel({
  po,
  lines,
  cycle,
}: {
  po: PoApproval;
  lines: PoApprovalLine[];
  cycle?: PoCycleTime;
}) {
  // The critical path as stored: days, and the dates they currently produce.
  const base = tnaBaseFor({ po_issued_at: po.po_issued_at });
  const stages = [
    { label: 'PP sample', days: po.tna_days_pp_sample, fallback: po.cs_pp_sample_due },
    { label: 'GPT', days: po.tna_days_gpt, fallback: po.cs_gpt_due },
    { label: 'Cutting start', days: po.tna_days_cutting, fallback: po.cs_cutting_start },
    { label: 'Inline QC', days: po.tna_days_inline_qc, fallback: po.cs_inline_qc_due },
    { label: 'First delivery', days: po.tna_days_first_delivery, fallback: po.critical_path_first_delivery },
    { label: 'PO closing', days: po.tna_days_po_closing, fallback: po.po_closing_date },
  ];
  const lineQty = lines.reduce((s, l) => s + Number(l.qty || 0), 0);

  return (
    <div className="wf-po-detail-body wf-po-readonly">
      <div className="wf-po-readonly-head">
        <strong>{po.request_id}</strong>
        <span className="wf-status">{STATUS_LABEL[po.status]}</span>
        <span className="wf-subtle">Read-only — use Edit to change a request before it is submitted.</span>
        {po.status === 'approved' && (
          <a className="wf-btn wf-btn-ghost wf-btn-sm" href={`/api/po/${po.id}/pdf`}>
            <FileDown size={14} /> Download PO PDF
          </a>
        )}
      </div>

      <div className="wf-po-readonly-grid">
        <Block title="Request">
          <Row label="Request ID">{po.request_id}</Row>
          <Row label="Category">{po.category?.toUpperCase() ?? '—'}</Row>
          <Row label="PO type">{text(po.po_type)}</Row>
          <Row label="Product code">{text(po.product_code)}</Row>
          <Row label="Raised by">{text(po.created_by)}</Row>
          <Row label="Raised on">{stamp(po.timestamp_created)}</Row>
        </Block>

        <Block title="Vendor">
          <Row label="Vendor code">
            {text(po.vendor_code)}
            {po.vendor_code && (
              <VendorHistoryButton
                vendorCode={po.vendor_code}
                productCode={po.product_code}
                label="PO history"
                className="wf-btn wf-btn-ghost wf-btn-sm wf-inline-btn"
              />
            )}
          </Row>
          <Row label="Vendor name">{text(po.vendor_name)}</Row>
          <Row label="TNA sheet">
            <Link href={po.tna_sheet_url} />
          </Row>
          <Row label="CAD folder">
            <Link href={po.cad_folder_url} />
          </Row>
        </Block>

        <Block title="Cost (per piece)">
          <Row label="Rate">{money(po.rate)}</Row>
          <Row label="CMTP">{money(po.cm_cost)}</Row>
          <Row label="Grey">{money(po.grey_cost)}</Row>
          <Row label="Finished fabric">{money(po.finished_fabric_cost)}</Row>
          <Row label="Margin %">{po.margin_pct == null ? '—' : `${po.margin_pct}%`}</Row>
          <Row label="Cost sheet">
            <Link href={po.cost_sheet_url} />
          </Row>
          <Row label="Set as benchmark">{yesNo(po.benchmark_cost)}</Row>
          <Row label="Above-standard CMTP approved">
            {po.cm_override_at ? `${text(po.cm_override_by)} · ${stamp(po.cm_override_at)}` : '—'}
          </Row>
          {po.cm_override_note && <Row label="Cost exception note">{po.cm_override_note}</Row>}
        </Block>

        <Block title="Quantity">
          <Row label="PO quantity">{Number(po.po_qty || 0).toLocaleString('en-IN')} pcs</Row>
          <Row label="SKU lines">{lines.length ? `${lines.length} lines · ${lineQty.toLocaleString('en-IN')} pcs` : 'none entered'}</Row>
        </Block>

        <Block title="Date log">
          <Row label="Request raised">{stamp(po.submitted_for_approval_at)}</Row>
          <Row label="Approved">{stamp(po.approved_at)}</Row>
          <Row label="EasyCom PO created">
            {po.po_issued_at ? stamp(po.po_issued_at) : 'not yet — the critical path has not started'}
          </Row>
          <Row label="Request → approval">{cycle?.days_to_approve != null ? `${cycle.days_to_approve} days` : '—'}</Row>
          <Row label="Approval → EasyCom">{cycle?.days_to_issue != null ? `${cycle.days_to_issue} days` : '—'}</Row>
          <Row label="Days requested at submission">{po.requested_total_days != null ? `${po.requested_total_days} days` : '—'}</Row>
        </Block>

        <Block title={`Critical path — ${base.source === 'issued' ? `from the EasyCom PO, ${day(base.date)}` : `projected from today, ${day(base.date)}`}`}>
          {stages.map((s) => (
            <Row key={s.label} label={s.label}>
              {s.days == null
                ? day(s.fallback)
                : `${s.days}d → ${day(addTnaDays(base.date, s.days) ?? s.fallback)}`}
            </Row>
          ))}
          <Row label="TNA confirmed">
            {po.tna_confirmed ? `${text(po.tna_confirmed_by)} · ${stamp(po.tna_confirmed_at)}` : 'not yet'}
          </Row>
          <Row label="Rebased on issuance">{po.tna_rebased_at ? stamp(po.tna_rebased_at) : '—'}</Row>
        </Block>

        <Block title="Buying plan">
          <Row label="Plan month">{text(po.buying_plan_no)}</Row>
          <Row label="In the plan">
            {po.in_buying_plan == null ? 'not checked yet' : po.in_buying_plan ? 'Yes' : 'No — ad-hoc'}
          </Row>
          <Row label="Approved plan qty">
            {po.plan_qty_at_submit == null ? '—' : `${Number(po.plan_qty_at_submit).toLocaleString('en-IN')} pcs`}
          </Row>
          <Row label="Ad-hoc reason">{text(po.ad_hoc_reason)}</Row>
          <Row label="Remark at submission">{text(po.submit_remark)}</Row>
        </Block>

        <Block title="Decision">
          <Row label="Status">{STATUS_LABEL[po.status]}</Row>
          <Row label="Approved by">{text(po.approved_by)}</Row>
          <Row label="Rejection notes">{text(po.rejection_notes)}</Row>
          <Row label="Rework notes">{text(po.rework_notes)}</Row>
          <Row label="Sent for rework by">
            {po.reworked_at ? `${text(po.reworked_by)} · ${stamp(po.reworked_at)}` : '—'}
          </Row>
          <Row label="Edited before approval">{yesNo(po.edited_before_approval)}</Row>
        </Block>

        <Block title="Issuance & signing">
          <Row label="EasyCom PO number">{text(po.easycom_po_no)}</Row>
          <Row label="EasyCom reference">{text(po.po_ref_num)}</Row>
          <Row label="Signed PO">
            <Link href={po.signed_po_document_url} />
          </Row>
          <Row label="Signed cost sheet">
            <Link href={po.signed_cost_sheet_url} />
          </Row>
          <Row label="Signed TNA">
            <Link href={po.signed_tna_url} />
          </Row>
          <Row label="Signed reference">{text(po.signed_po_ref_number)}</Row>
          <Row label="Date of PO sign">{day(po.date_of_po_sign)}</Row>
          <Row label="Trim card signed">{yesNo(po.trim_card_signed)}</Row>
          <Row label="First actual delivery">{day(po.first_actual_delivery_date)}</Row>
        </Block>
      </div>

      {lines.length > 0 && (
        <div className="table-scroll">
          <table className="wf-grid wf-cost-lines">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Variant</th>
                <th>Size</th>
                <th className="num">Qty</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => {
                const variant = (l.product_variant ?? '').trim().toUpperCase();
                const size = (l.size ?? '').trim().toUpperCase();
                return (
                  <tr key={l.id}>
                    <td className="mono">{size ? `${variant}_${size}` : variant || '—'}</td>
                    <td>{variant || '—'}</td>
                    <td>{size || '—'}</td>
                    <td className="num">{Number(l.qty || 0).toLocaleString('en-IN')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
