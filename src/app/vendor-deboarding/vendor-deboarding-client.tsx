'use client';

import { useMemo, useState, useTransition } from 'react';
import { HeaderInfo } from '@/components/header-info';
import { Download, UserX } from 'lucide-react';
import { downloadCsv } from '@/lib/download';
import { reloadWithToast, toastError } from '@/lib/toast';
import { createVendorDeboardingRequest } from '@/lib/forms/actions';
import { canApprove, canEdit } from '@/lib/forms/approval';
import { Field, Notice, StatusBadge } from '@/components/forms/form-layout';
import { ApprovalBar } from '@/components/forms/approval-bar';
import {
  DEBOARDING_REASONS,
  DEBOARDING_REASON_LABEL,
  DEBOARDING_SCORES,
  SCORE_SCALE,
} from '@/lib/forms/deboarding';
import type {
  SdRole,
  VendorDeboardingHistory,
  VendorDeboardingReason,
  VendorDeboardingRequest,
  VendorDeboardingVendor,
} from '@/lib/forms/types';

type ScoreKey = (typeof DEBOARDING_SCORES)[number]['key'];
type Scores = Record<ScoreKey, number | null>;
const EMPTY_SCORES: Scores = {
  behaviour_score: null,
  work_style_score: null,
  quality_score: null,
  process_score: null,
};

const fmtPct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 10) / 10}%`);
const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';
/** The form's reasons were typed in capitals; read them as words. */
const reasonWords = (r: string) => r.toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** 1–5 picker: five buttons, the chosen one highlighted. */
function ScorePicker({ value, onChange }: { value: number | null; onChange: (n: number) => void }) {
  return (
    <div className="segment wf-segment" role="radiogroup">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          className={value === n ? 'active' : ''}
          onClick={() => onChange(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

export function VendorDeboardingClient({
  requests,
  vendors,
  history = [],
  role,
}: {
  requests: VendorDeboardingRequest[];
  vendors: VendorDeboardingVendor[];
  /** De-boardings from the Google Form the team used before this page (read-only). */
  history?: VendorDeboardingHistory[];
  role: SdRole;
}) {
  const editable = canEdit(role, 'draft');
  const [vendorCode, setVendorCode] = useState('');
  const [reason, setReason] = useState<VendorDeboardingReason | ''>('');
  const [reasonOther, setReasonOther] = useState('');
  const [scores, setScores] = useState<Scores>(EMPTY_SCORES);
  // The counted evidence. Pre-filled from data when a vendor is picked; editable.
  const [posDone, setPosDone] = useState('');
  const [late15, setLate15] = useState('');
  const [late1m, setLate1m] = useState('');
  const [lateOver1m, setLateOver1m] = useState('');
  const [rejectionPct, setRejectionPct] = useState('');
  const [resolvable, setResolvable] = useState<'yes' | 'no' | ''>('');
  const [remarks, setRemarks] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const vendor = useMemo(() => vendors.find((v) => v.vendor_code === vendorCode) ?? null, [vendors, vendorCode]);
  const liveRequestFor = useMemo(
    () => new Set(requests.filter((r) => r.status !== 'rejected').map((r) => r.vendor_code.toUpperCase())),
    [requests],
  );
  // Vendors already de-boarded on the old form — shown on the picker so nobody raises a
  // second request for a vendor the team stopped working with a year ago.
  const formDeboardedOn = useMemo(() => {
    const m = new Map<string, string>();
    for (const h of history) {
      const code = h.vendor_code.toUpperCase();
      if (!m.has(code)) m.set(code, h.submitted_at);
    }
    return m;
  }, [history]);

  function downloadHistory() {
    downloadCsv(
      'vendor-deboarding-google-form',
      [
        'Submitted', 'Submitted by', 'Vendor code', 'Vendor name', 'POs done', 'Reasons',
        'Behaviour (1-5)', 'Work style (1-5)', 'Quality (1-5)', 'Process (1-5)',
        'POs 15 days late', 'POs 1 month late', 'POs over 1 month late', 'Rejection %',
        'Resolvable', 'Remarks', 'Status in EE', 'Note',
      ],
      history.map((h) => [
        h.submitted_at, h.submitted_by, h.vendor_code, h.vendor_name, h.pos_done, h.reasons.join('; '),
        h.behaviour_score, h.work_style_score, h.quality_score, h.process_score,
        h.pos_late_15d, h.pos_late_1m, h.pos_late_over_1m, h.rejection_pct,
        h.resolvable == null ? '' : h.resolvable ? 'Yes' : 'No', h.remarks, h.ee_status, h.note,
      ]),
    );
  }

  function pickVendor(code: string) {
    setVendorCode(code);
    const v = vendors.find((x) => x.vendor_code === code);
    // Data first; the person can overwrite any figure they know to be different.
    setPosDone(v?.stats ? String(v.stats.posDone) : '');
    setLate15(v?.stats ? String(v.stats.late15d) : '');
    setLate1m(v?.stats ? String(v.stats.late1m) : '');
    setLateOver1m(v?.stats ? String(v.stats.lateOver1m) : '');
    setRejectionPct(v?.rejectionPct == null ? '' : String(Math.round(v.rejectionPct * 100) / 100));
  }

  const canSend =
    !!vendorCode &&
    !!reason &&
    (reason !== 'other' || !!reasonOther.trim()) &&
    DEBOARDING_SCORES.every((s) => scores[s.key] != null) &&
    posDone !== '' &&
    !!resolvable &&
    !!remarks.trim();

  function submit() {
    setError(null);
    setMessage(null);
    const payload = new FormData();
    payload.set('vendor_code', vendorCode);
    payload.set('vendor_name', vendor?.vendor_name ?? '');
    payload.set('reason', reason);
    payload.set('reason_other', reasonOther);
    for (const s of DEBOARDING_SCORES) payload.set(s.key, String(scores[s.key] ?? ''));
    payload.set('pos_done', posDone);
    payload.set('pos_late_15d', late15 || '0');
    payload.set('pos_late_1m', late1m || '0');
    payload.set('pos_late_over_1m', lateOver1m || '0');
    payload.set('rejection_pct', rejectionPct);
    payload.set('resolvable', resolvable);
    payload.set('remarks', remarks);
    start(async () => {
      const result = await createVendorDeboardingRequest(payload);
      if (result.ok) {
        setMessage(result.message ?? 'Submitted.');
        setVendorCode('');
        setReason('');
        setReasonOther('');
        setScores(EMPTY_SCORES);
        setPosDone('');
        setLate15('');
        setLate1m('');
        setLateOver1m('');
        setRejectionPct('');
        setResolvable('');
        setRemarks('');
        reloadWithToast();
      } else setError(toastError(result.error));
    });
  }

  return (
    <>
      <Notice tone="info">
        This replaces the Google Form. Pick the vendor, give the reason and the four ratings,
        and check the PO evidence — it is filled in from completed-PO and goods-receipt data
        and can be corrected. The request goes to the approval queue and{' '}
        <strong>always needs an admin</strong>. Approval records the decision here; the vendor
        is not switched off in EasyEcom by this page.
      </Notice>

      {message && <Notice tone="ok">{message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {editable && (
        <div className="panel wf-form-panel">
          <div className="panel-title">
            <h3>Raise a de-boarding request</h3>
          </div>

          <div className="wf-form-grid">
            <Field label="Vendor">
              <select value={vendorCode} onChange={(e) => pickVendor(e.target.value)}>
                <option value="">Select…</option>
                {vendors.map((v) => (
                  <option key={v.vendor_code} value={v.vendor_code} disabled={liveRequestFor.has(v.vendor_code)}>
                    {v.vendor_code} — {v.vendor_name}
                    {!v.isActive ? ' (inactive in EasyEcom)' : ''}
                    {liveRequestFor.has(v.vendor_code) ? ' (request already open)' : ''}
                    {formDeboardedOn.has(v.vendor_code.toUpperCase())
                      ? ` (de-boarded on the Google Form, ${fmtDate(formDeboardedOn.get(v.vendor_code.toUpperCase()) ?? null)})`
                      : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Reason for de-listing">
              <select value={reason} onChange={(e) => setReason(e.target.value as VendorDeboardingReason | '')}>
                <option value="">Select…</option>
                {DEBOARDING_REASONS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            {reason === 'other' && (
              <Field label="What is the other reason?">
                <input value={reasonOther} onChange={(e) => setReasonOther(e.target.value)} />
              </Field>
            )}
          </div>

          {vendor && (
            <dl className="wf-queue-meta">
              <div>
                <dt>PO type · merchandiser</dt>
                <dd>
                  {vendor.primary_type || '—'} · {vendor.merchant || '—'}
                </dd>
              </div>
              <div>
                <dt>Onboarded</dt>
                <dd>{vendor.onboarding_date ? new Date(vendor.onboarding_date).toLocaleDateString('en-IN') : '—'}</dd>
              </div>
              <div>
                <dt>Open POs with this vendor now</dt>
                <dd>{vendor.openPoCount}</dd>
              </div>
              <div>
                <dt>Status in EasyEcom</dt>
                <dd>{vendor.isActive ? 'Active' : 'Inactive'}</dd>
              </div>
            </dl>
          )}

          <div className="wf-form-grid">
            <Field label="POs completed by this vendor" hint={vendor?.stats ? 'From completed-PO data; correct it if you know better' : 'No completed POs on record — enter the count'}>
              <input type="number" min={0} step={1} value={posDone} onChange={(e) => setPosDone(e.target.value)} />
            </Field>
            <Field label="POs completed 15–29 days late" hint="Days after the expected delivery date">
              <input type="number" min={0} step={1} value={late15} onChange={(e) => setLate15(e.target.value)} />
            </Field>
            <Field label="POs completed 30–60 days late">
              <input type="number" min={0} step={1} value={late1m} onChange={(e) => setLate1m(e.target.value)} />
            </Field>
            <Field label="POs completed more than 60 days late">
              <input type="number" min={0} step={1} value={lateOver1m} onChange={(e) => setLateOver1m(e.target.value)} />
            </Field>
            <Field label="Rejection at goods receipt (%)" hint={vendor?.rejectionPct != null ? 'From GRN QC fails ÷ pieces checked' : 'No GRN QC data for this vendor'}>
              <input type="number" min={0} max={100} step={0.01} value={rejectionPct} onChange={(e) => setRejectionPct(e.target.value)} />
            </Field>
          </div>

          <div className="wf-form-grid">
            {DEBOARDING_SCORES.map((s) => (
              <Field key={s.key} label={s.label} hint={SCORE_SCALE}>
                <ScorePicker value={scores[s.key]} onChange={(n) => setScores((prev) => ({ ...prev, [s.key]: n }))} />
              </Field>
            ))}
            <Field label="Is the issue with this vendor resolvable?">
              <div className="segment wf-segment" role="radiogroup">
                {(['yes', 'no'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={resolvable === v}
                    className={resolvable === v ? 'active' : ''}
                    onClick={() => setResolvable(v)}
                  >
                    {v === 'yes' ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Remarks on the vendor">
              <textarea
                className="wf-textarea"
                rows={3}
                value={remarks}
                placeholder="What happened, and why de-boarding is the right call"
                onChange={(e) => setRemarks(e.target.value)}
              />
            </Field>
          </div>

          <div className="wf-footer-actions">
            <button type="button" className="wf-btn wf-btn-primary" onClick={submit} disabled={pending || !canSend}>
              <UserX size={15} /> {pending ? 'Submitting…' : 'Submit for approval'}
            </button>
          </div>
        </div>
      )}

      <div className="table-panel">
        <div className="table-meta">
          <h3>De-boarding requests</h3>
          <span>{requests.length} total</span>
        </div>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Reason <HeaderInfo label="Reason" /></th>
                <th>Ratings (1–5) <HeaderInfo label="Ratings (1–5)" /></th>
                <th className="num">POs done <HeaderInfo label="POs done" /></th>
                <th className="num">Late 15–29d / 30–60d / &gt;60d <HeaderInfo label="Late 15–29d / 30–60d / &gt;60d" /></th>
                <th className="num">Rejection % <HeaderInfo label="Rejection %" /></th>
                <th>Resolvable <HeaderInfo label="Resolvable" /></th>
                <th>Remarks <HeaderInfo label="Remarks" /></th>
                <th>Status <HeaderInfo label="Status" /></th>
                <th>Requested by <HeaderInfo label="Requested by" /></th>
                <th>Decision <HeaderInfo label="Decision" /></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="mono">{r.vendor_code}</span>
                    {r.vendor_name && <small className="wf-subtle"> {r.vendor_name}</small>}
                  </td>
                  <td>
                    {DEBOARDING_REASON_LABEL[r.reason] ?? r.reason}
                    {r.reason === 'other' && r.reason_other && <small className="wf-subtle"> — {r.reason_other}</small>}
                  </td>
                  <td className="wf-subtle">
                    {DEBOARDING_SCORES.map((s) => `${s.short} ${r[s.key]}`).join(' · ')}
                  </td>
                  <td className="num">{r.pos_done}</td>
                  <td className="num">
                    {r.pos_late_15d} / {r.pos_late_1m} / {r.pos_late_over_1m}
                  </td>
                  <td className="num">{fmtPct(r.rejection_pct == null ? null : Number(r.rejection_pct))}</td>
                  <td>{r.resolvable ? 'Yes' : 'No'}</td>
                  <td>{r.remarks}</td>
                  <td>
                    <StatusBadge status={r.status} />
                    {r.status === 'rejected' && r.rejection_notes && (
                      <small className="wf-subtle">{r.rejection_notes}</small>
                    )}
                    {r.status === 'rework' && r.rework_notes && (
                      <small className="wf-subtle">{r.rework_notes}</small>
                    )}
                  </td>
                  <td className="wf-subtle">{r.requested_by ?? '—'}</td>
                  <td>
                    {canApprove(role, r.status) ? (
                      <ApprovalBar
                        entityType="vendor_deboarding"
                        entityId={String(r.id)}
                        entityLabel={`De-board vendor — ${r.vendor_code}${r.vendor_name ? ` ${r.vendor_name}` : ''}`}
                        onDone={(result) => {
                          if (result.ok) reloadWithToast(result.message ?? 'Saved.');
                        }}
                      />
                    ) : (
                      <span className="wf-subtle">{r.approved_by ?? '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
              {!requests.length && (
                <tr>
                  <td colSpan={11} className="wf-empty-cell">
                    No de-boarding requests yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* The Google Form era. Read-only: these were decided before the dashboard existed,
          so there is nothing to approve — they are the record of who was de-listed and why. */}
      <div className="table-panel">
        <div className="table-meta">
          <h3>De-boarded before this page — the Google Form</h3>
          <span>
            {history.length} responses
            {history.length ? ` · ${fmtDate(history[history.length - 1].submitted_at)} to ${fmtDate(history[0].submitted_at)}` : ''}
          </span>
          {history.length > 0 && (
            <button type="button" className="wf-btn wf-btn-ghost wf-btn-sm" onClick={downloadHistory}>
              <Download size={13} /> Download CSV
            </button>
          )}
        </div>
        <p className="wf-subtle" style={{ margin: '0 0 8px' }}>
          Responses to the Vendor De-Boarding Google Form, as they were written. The form
          allowed more than one reason per vendor and had no approval step, so these rows are
          the decisions as recorded, not requests. A vendor on this list is flagged
          &ldquo;De-boarded&rdquo; wherever vendors are picked, the same as an approved request here.
        </p>
        <div className="table-scroll">
          <table className="wide-table">
            <thead>
              <tr>
                <th>Submitted <HeaderInfo label="Submitted" /></th>
                <th>Vendor <HeaderInfo label="Vendor" /></th>
                <th>Reasons <HeaderInfo label="Reasons" /></th>
                <th>Ratings (1–5) <HeaderInfo label="Ratings (1–5)" /></th>
                <th className="num">POs done <HeaderInfo label="POs done" /></th>
                <th className="num">Late 15d / 1m / &gt;1m <HeaderInfo label="Late 15–29d / 30–60d / &gt;60d" /></th>
                <th className="num">Rejection % <HeaderInfo label="Rejection %" /></th>
                <th>Resolvable <HeaderInfo label="Resolvable" /></th>
                <th>Remarks <HeaderInfo label="Remarks" /></th>
                <th>Status in EE <HeaderInfo label="Status in EE" /></th>
                <th>Note <HeaderInfo label="Note" /></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id}>
                  <td>
                    {fmtDate(h.submitted_at)}
                    {h.submitted_by && <small className="wf-subtle"> {h.submitted_by}</small>}
                  </td>
                  <td>
                    <span className="mono">{h.vendor_code}</span>
                    {h.vendor_name && <small className="wf-subtle"> {h.vendor_name}</small>}
                  </td>
                  <td>{h.reasons.length ? h.reasons.map(reasonWords).join(', ') : '—'}</td>
                  <td className="wf-subtle">
                    {DEBOARDING_SCORES.map((s) => `${s.short} ${h[s.key] ?? '—'}`).join(' · ')}
                  </td>
                  <td className="num">{h.pos_done ?? '—'}</td>
                  <td className="num">
                    {h.pos_late_15d ?? '—'} / {h.pos_late_1m ?? '—'} / {h.pos_late_over_1m ?? '—'}
                  </td>
                  <td className="num">{fmtPct(h.rejection_pct)}</td>
                  <td>{h.resolvable == null ? '—' : h.resolvable ? 'Yes' : 'No'}</td>
                  <td>{h.remarks || '—'}</td>
                  <td>{h.ee_status || '—'}</td>
                  <td className="wf-subtle">{h.note || '—'}</td>
                </tr>
              ))}
              {!history.length && (
                <tr>
                  <td colSpan={11} className="wf-empty-cell">
                    Nothing imported from the Google Form.
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
