'use client';

import { useMemo, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { Download, FilePen } from 'lucide-react';
import { downloadCsv } from '@/lib/download';
import { reloadWithToast, toastError } from '@/lib/toast';
import { createPoAmendment } from '@/lib/forms/actions';
import { canApprove, canEdit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import { istToday } from '@/lib/business-logic';
import type { IssuedPo, PoAmendment, PoAmendmentType, SdRole } from '@/lib/forms/types';

const TYPE_LABEL: Record<PoAmendmentType, string> = {
  cost: 'Cost (rate per piece)',
  quantity: 'Quantity (pieces)',
  time: 'Time (delivery date)',
};

const money = (v: number | null) =>
  v == null ? '—' : `₹${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(v)}`;
const pcs = (v: number | null) => (v == null ? '—' : `${new Intl.NumberFormat('en-IN').format(v)} pcs`);
const day = (iso: string | null) =>
  iso ? new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—';
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';

/** "before → after" for one amendment, in the unit of its kind. */
function changeText(a: PoAmendment): string {
  if (a.amendment_type === 'cost') return `${money(a.current_rate)} → ${money(a.new_rate)} per piece`;
  if (a.amendment_type === 'quantity') return `${pcs(a.current_qty)} → ${pcs(a.new_qty)}`;
  return `${day(a.current_delivery_date)} → ${day(a.new_delivery_date)}`;
}

const MAX_PICKER = 80;

export function PoAmendmentClient({
  issued,
  amendments,
  role,
}: {
  issued: IssuedPo[];
  amendments: PoAmendment[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const today = istToday().toISOString().slice(0, 10);

  const [search, setSearch] = useState('');
  const [poRef, setPoRef] = useState('');
  const [type, setType] = useState<PoAmendmentType | ''>('');
  const [newRate, setNewRate] = useState('');
  const [newQty, setNewQty] = useState('');
  const [newDate, setNewDate] = useState('');
  const [agreedOn, setAgreedOn] = useState(today);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  const po = useMemo(() => issued.find((p) => p.po_ref_num === poRef) ?? null, [issued, poRef]);

  // 700 open POs is too many for one dropdown — type a few characters of the reference,
  // number, vendor or product and the list narrows to the matches.
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? issued.filter((p) =>
          [p.po_ref_num, p.po_number, p.vendor_code, p.vendor_name, p.product_codes]
            .filter(Boolean)
            .some((s) => String(s).toLowerCase().includes(q)),
        )
      : issued;
    return list.slice(0, MAX_PICKER);
  }, [issued, search]);

  // Which amendments are open on the chosen PO — the same kind cannot be raised twice.
  const openOnPo = useMemo(
    () =>
      new Set(
        amendments
          .filter((a) => a.po_ref_num === poRef && ['draft', 'submitted', 'pending_l2', 'rework'].includes(a.status))
          .map((a) => a.amendment_type),
      ),
    [amendments, poRef],
  );

  const received = po ? Math.max(0, po.ordered_qty - po.pending_qty) : 0;

  const canSend =
    !!po &&
    !!type &&
    !openOnPo.has(type) &&
    (type === 'cost' ? Number(newRate) > 0 : type === 'quantity' ? newQty !== '' : !!newDate) &&
    !!agreedOn &&
    !!reason.trim();

  function submit() {
    setError(null);
    setMessage(null);
    const fd = new FormData();
    fd.set('po_ref_num', poRef);
    fd.set('amendment_type', type);
    fd.set('new_rate', newRate);
    fd.set('new_qty', newQty);
    fd.set('new_delivery_date', newDate);
    fd.set('agreed_with_vendor_on', agreedOn);
    fd.set('reason', reason);
    fd.set('evidence_url', evidence);
    start(async () => {
      const result = await createPoAmendment(fd);
      if (result.ok) {
        setMessage(result.message ?? 'Submitted.');
        setPoRef('');
        setType('');
        setNewRate('');
        setNewQty('');
        setNewDate('');
        setReason('');
        setEvidence('');
        reloadWithToast();
      } else setError(toastError(result.error));
    });
  }

  function downloadAll() {
    downloadCsv(
      'po-amendments',
      ['ID', 'PO reference', 'EasyEcom PO no', 'Vendor', 'Products', 'Type', 'Before', 'After', 'Agreed with vendor on', 'Reason', 'Status', 'Raised by', 'Raised at', 'Decided by', 'Decided at'],
      amendments.map((a) => [
        a.id, a.po_ref_num, a.po_number, a.vendor_name ?? a.vendor_code, a.product_codes, a.amendment_type,
        a.amendment_type === 'cost' ? a.current_rate : a.amendment_type === 'quantity' ? a.current_qty : a.current_delivery_date,
        a.amendment_type === 'cost' ? a.new_rate : a.amendment_type === 'quantity' ? a.new_qty : a.new_delivery_date,
        a.agreed_with_vendor_on, a.reason, a.status, a.requested_by, a.requested_at, a.approved_by, a.approved_at,
      ]),
    );
  }

  return (
    <>
      <Notice tone="info">
        For a PO that is <strong>already issued in EasyEcom</strong>. Pick the PO, say what changes —
        the cost, the quantity or the delivery date — and why. The PO&apos;s current figure is read
        from EasyEcom and shown beside the new one. The request follows the same approval route as
        the PO itself. <strong>Finance accepts an amendment only when it is recorded on the day it
        was agreed with the vendor</strong>, so the agreed date must be today. Approval is the record
        Finance acts on; the PO is changed in EasyEcom separately.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>
              <FilePen size={15} /> Raise an amendment
            </h3>
          </div>

          <div className="wf-form-grid">
            <Field label="Find the PO" hint="Reference, EasyEcom number, vendor or product">
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. FY26-27/EFOB or CFK or SDFAK" />
            </Field>
            <Field
              label="Issued PO"
              hint={
                matches.length === MAX_PICKER
                  ? `Showing the first ${MAX_PICKER} of ${issued.length} — narrow the search`
                  : `${matches.length} of ${issued.length} open POs`
              }
            >
              <select value={poRef} onChange={(e) => setPoRef(e.target.value)}>
                <option value="">Select…</option>
                {matches.map((p) => (
                  <option key={p.po_ref_num} value={p.po_ref_num}>
                    {p.po_ref_num} · {p.vendor_code ?? '—'} · {p.product_codes ?? '—'} · {p.ordered_qty} pcs
                  </option>
                ))}
              </select>
            </Field>
            <Field label="What changes">
              <select value={type} onChange={(e) => setType(e.target.value as PoAmendmentType | '')}>
                <option value="">Select…</option>
                {(Object.keys(TYPE_LABEL) as PoAmendmentType[]).map((t) => (
                  <option key={t} value={t} disabled={openOnPo.has(t)}>
                    {TYPE_LABEL[t]}
                    {openOnPo.has(t) ? ' (an amendment is already open)' : ''}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {po && (
            <dl className="wf-queue-meta">
              <div>
                <dt>Vendor</dt>
                <dd>
                  {po.vendor_name || '—'} {po.vendor_code ? <span className="mono">({po.vendor_code})</span> : null}
                </dd>
              </div>
              <div>
                <dt>EasyEcom PO no · issued</dt>
                <dd>
                  {po.po_number ?? '—'} · {day(po.po_date)}
                </dd>
              </div>
              <div>
                <dt>Products</dt>
                <dd>{po.product_codes ?? '—'}</dd>
              </div>
              <div>
                <dt>Ordered · pending · received</dt>
                <dd>
                  {pcs(po.ordered_qty)} · {pcs(po.pending_qty)} · {pcs(received)}
                </dd>
              </div>
              <div>
                <dt>Rate on the PO</dt>
                <dd>{money(po.rate)} per piece{po.lines > 1 ? ' (quantity-weighted across lines)' : ''}</dd>
              </div>
              <div>
                <dt>Expected delivery</dt>
                <dd>{day(po.expected_delivery_date)}</dd>
              </div>
            </dl>
          )}

          {po && type && (
            <div className="wf-form-grid">
              {type === 'cost' && (
                <Field label="New rate per piece (₹)" hint={`Now ${money(po.rate)}`}>
                  <input type="number" min={0} step={0.01} value={newRate} onChange={(e) => setNewRate(e.target.value)} />
                </Field>
              )}
              {type === 'quantity' && (
                <Field
                  label="New quantity (pieces)"
                  hint={`Now ${pcs(po.ordered_qty)}${received > 0 ? ` — ${pcs(received)} already received, so not below that` : ''}`}
                >
                  <input type="number" min={received} step={1} value={newQty} onChange={(e) => setNewQty(e.target.value)} />
                </Field>
              )}
              {type === 'time' && (
                <Field label="New delivery date" hint={`Now ${day(po.expected_delivery_date)}`}>
                  <input type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
                </Field>
              )}
              <Field label="Agreed with the vendor on" hint="Must be today — Finance does not accept a change recorded later">
                <input type="date" value={agreedOn} max={today} onChange={(e) => setAgreedOn(e.target.value)} />
              </Field>
              <Field label="Evidence link (optional)" hint="Vendor mail, revised cost sheet, chat screenshot">
                <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="https://…" />
              </Field>
            </div>
          )}

          {po && type && (
            <Field label="Reason for the amendment" hint="Required — what changed and why, in the words Finance will read">
              <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
          )}

          <div className="wf-footer-actions">
            <button type="button" className="wf-btn wf-btn-primary" disabled={!canSend || busy} onClick={submit}>
              {busy ? 'Sending…' : 'Send for approval'}
            </button>
            {agreedOn && agreedOn !== today && (
              <span className="wf-subtle">The agreed date is not today — Finance will not accept this one.</span>
            )}
          </div>
        </div>
      )}

      <div className="table-panel">
        <div className="table-meta">
          <h3>Amendments</h3>
          <span>{amendments.length} total</span>
          {amendments.length > 0 && (
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadAll}>
              <Download size={13} /> Download CSV
            </button>
          )}
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>PO <HeaderInfo label="PO" /></th>
                <th>Type <HeaderInfo label="Type" /></th>
                <th>Change <HeaderInfo label="Change" /></th>
                <th>Agreed on <HeaderInfo label="Agreed on" /></th>
                <th>Reason <HeaderInfo label="Reason" /></th>
                <th>Status <HeaderInfo label="Status" /></th>
                <th>Raised by <HeaderInfo label="Raised by" /></th>
                <th>Decision <HeaderInfo label="Decision" /></th>
              </tr>
            </thead>
            <tbody>
              {amendments.map((a) => (
                <tr key={a.id}>
                  <td>
                    <span className="mono">{a.po_ref_num}</span>
                    <small className="wf-subtle">
                      {' '}
                      {a.vendor_name ?? a.vendor_code ?? ''}
                      {a.product_codes ? ` · ${a.product_codes}` : ''}
                      {a.po_number ? ` · EE ${a.po_number}` : ''}
                    </small>
                  </td>
                  <td>{TYPE_LABEL[a.amendment_type]}</td>
                  <td className="strong">{changeText(a)}</td>
                  <td>{day(a.agreed_with_vendor_on)}</td>
                  <td>
                    {a.reason}
                    {a.evidence_url && (
                      <>
                        {' '}
                        <a href={a.evidence_url} target="_blank" rel="noreferrer">
                          evidence ↗
                        </a>
                      </>
                    )}
                  </td>
                  <td>
                    <StatusBadge status={a.status} edited={a.edited_before_approval} approverEdited={a.approver_edited} />
                    {a.status === 'rejected' && a.rejection_notes && <small className="wf-subtle">{a.rejection_notes}</small>}
                    {a.status === 'rework' && a.rework_notes && <small className="wf-subtle">{a.rework_notes}</small>}
                  </td>
                  <td className="wf-subtle">
                    {a.requested_by ?? '—'}
                    <small> {when(a.requested_at)}</small>
                  </td>
                  <td>
                    {canApprove(role, a.status) ? (
                      <ApprovalBar
                        entityType="po_amendment"
                        entityId={String(a.id)}
                        entityLabel={`PO amendment — ${a.po_ref_num} · ${changeText(a)}`}
                        onDone={(result) => {
                          if (result.ok) reloadWithToast(result.message ?? 'Saved.');
                        }}
                      />
                    ) : (
                      <span className="wf-subtle">
                        {a.approved_by ?? '—'}
                        {a.approved_at ? <small> {when(a.approved_at)}</small> : null}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              {!amendments.length && (
                <tr>
                  <td colSpan={8} className="wf-empty-cell">
                    No amendments raised yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
