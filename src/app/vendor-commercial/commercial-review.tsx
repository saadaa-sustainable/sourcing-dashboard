'use client';
import { useId, useState, useTransition, type KeyboardEvent } from 'react';
import { decideCommercialRequest, linkCommercialVendor, createCommercialVendorLogin, signCommercialFile } from '@/lib/forms/actions-modules/vendor-commercial';
import { BUSINESS_TYPES, REMARKS_LABEL, costReasonLabel, requestTypeLabel } from '@/lib/forms/commercial';
import { COMMERCIAL_EXTRA_FIELDS, commercialImpact, holdWaiverDays, grnDelayDays, fabricConsumptionIncrease } from '@/lib/forms/commercial-workflow';
import type { VendorCommercialRequest } from '@/lib/forms/types';
import type { CommercialEvent, CommercialAccount } from '@/lib/forms/queries-modules/vendor-commercial';
import { reloadWithToast } from '@/lib/toast';

const stamp = (v: string | null) => v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';
const historyLabels: Record<string, string> = {
  status: 'Status', vendor_code: 'Vendor code', vendor_name: 'Vendor name', po_numbers: 'Purchase order',
  request_type: 'Request type', business_type: 'Business type', hold_qty: 'Hold quantity', hold_days: 'Hold days', ready_date: 'Ready date',
  cost_reason: 'Cost reasons', cost_reason_other: 'Other reason', increment_amount: 'Increment per unit', remarks: 'Remarks',
  owner_name: 'Owner name', owner_contact: 'Owner contact', invoice_number: 'Invoice number', invoice_date: 'Invoice date', invoice_amount: 'Invoice amount', rg_pending: 'RG pending',
  debit_note_number: 'Debit note', credit_amount: 'Credit amount', attachments: 'Attachments', approved_amount: 'Approved amount',
  decision_notes: 'Decision remarks', rework_notes: 'Rework reason', rejection_notes: 'Rejection reason', processing_status: 'Finance status', processed_amount: 'Processed amount', processed_reference: 'Processing reference',
};
const historyValue = (key: string, value: unknown) => {
  if (value == null || value === '') return '—';
  if (key === 'attachments') return (value as { name: string }[]).map((a) => a.name).join(', ') || '—';
  if (key === 'status') return ({ pending_l2: 'Approval Pending', submitted: 'Approval Pending', draft: 'Draft', approved: 'Approved', rework: 'Rework', rejected: 'Rejected' } as Record<string, string>)[String(value)] ?? String(value);
  return String(value);
};
export function CommercialReview({ request: r, events, admin, standalone = false }: { request: VendorCommercialRequest; events: CommercialEvent[]; admin: boolean; standalone?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const impact = commercialImpact(r.request_type, r.details ?? {}, r.increment_amount, r.invoice_amount, r.credit_amount);
  const isHold = r.request_type === 'hold_waiver';
  const waiverDays = isHold ? holdWaiverDays(r.details ?? {}) : null;
  const consumptionIncrease = r.request_type === 'surplus_fabric_consumption' ? fabricConsumptionIncrease(r.details?.initial_consumption ?? '', r.details?.revised_consumption ?? '') : null;
  const [approved, setApproved] = useState(String(r.approved_amount ?? (r.request_type === 'cost_increment' ? r.increment_amount : impact) ?? ''));
  const [processed, setProcessed] = useState(String(r.approved_amount ?? ''));
  const [reference, setReference] = useState('');
  function act(decision: string) {
    start(async () => {
      setError('');
      try {
        const fd = new FormData();
        for (const [key, value] of Object.entries({ id: String(r.id), revision: String(r.revision), decision, notes, approved_amount: approved, processed_amount: processed, processed_reference: reference })) fd.set(key, value);
        const result = await decideCommercialRequest(fd);
        if (result.ok) reloadWithToast(result.message); else setError(result.error);
      } catch { setError('Could not update this request. Please try again.'); }
    });
  }
  const Container = standalone ? 'section' : 'details';
  const value = (entry: unknown) => entry == null || entry === '' ? '—' : String(entry);
  const baseFields: [string, string][] = [
    ['Business type', BUSINESS_TYPES.find((business) => business.key === r.business_type)?.label ?? r.business_type],
    ['Type of request', requestTypeLabel(r.request_type, r.business_type)],
  ];
  const typeFields: Record<VendorCommercialRequest['request_type'], [string, string][]> = {
    hold_waiver: [
      ['Total hold qty', value(r.hold_qty)],
      ['Total days hold asked by the SAADAA team', value(r.hold_days)],
      ['Goods / fabric ready date', value(r.ready_date)],
    ],
    cost_increment: [
      ['Mention rate (increased amount you are requesting for)', value(r.increment_amount)],
      ['Reason for commercial approval', costReasonLabel(r.business_type, r.cost_reason)],
      ...(r.cost_reason?.split(',').includes('other') ? [['Write the reason', value(r.cost_reason_other)]] as [string, string][] : []),
    ],
    cash_discount: [
      ['Owner name', value(r.owner_name)], ['Owner contact number', value(r.owner_contact)],
      ['Invoice number', value(r.invoice_number)], ['Invoice date', value(r.invoice_date)],
      ['Invoice amount (₹)', value(r.invoice_amount)], ['RG pending with vendor', value(r.rg_pending)],
    ],
    dn_removal: [['Debit note number', value(r.debit_note_number)]],
    credit_note: [['Amount (₹)', value(r.credit_amount)]],
    grn_delay_waiver: [], surplus_fabric_consumption: [],
  };
  const groups: { title: string; rows: [string, string][] }[] = [
    { title: 'Request overview', rows: [
      ['Vendor', `${r.vendor_name ?? '—'} · ${r.vendor_code}`],
      ['Status', historyValue('status', r.status)],
      ['Purchase order', r.po_numbers],
      ['Requested by', r.requested_by ?? '—'],
      ['Requested at (IST)', stamp(r.requested_at)],
      ['Last updated (IST)', stamp(r.updated_at)],
    ] },
    { title: isHold ? 'Hold and waiver details' : 'Request details', rows: [
      ...baseFields,
      ...typeFields[r.request_type],
      ...COMMERCIAL_EXTRA_FIELDS[r.request_type].filter((field) =>
        (!isHold || field.key !== 'requested_amount') &&
        (!['cost_increment', 'cash_discount'].includes(r.request_type) || !!r.details?.[field.key])
      ).map((field): [string, string] => [field.label, value(field.key === 'grn_delay_days' ? grnDelayDays(r.details ?? {}) : field.key === 'consumption_increase_percent' ? consumptionIncrease ? `${consumptionIncrease.percent}%` : null : r.details?.[field.key])]),
      ...(isHold ? [['Waiver duration', waiverDays == null ? 'Enter hold dates to calculate' : `${waiverDays} days (hold end − hold start)`]] as [string, string][] : []),
      ...(!['grn_delay_waiver', 'surplus_fabric_consumption'].includes(r.request_type) || r.remarks ? [[REMARKS_LABEL[r.request_type], value(r.remarks)]] as [string, string][] : []),
    ] },
    { title: 'Decision and processing', rows: [
      ...(isHold ? [['Approved waiver', r.details?.approved_waiver_days == null ? 'Awaiting approval' : `${r.details.approved_waiver_days} days`]] as [string, string][] : [
        ['Requested financial impact', impact == null ? 'Not specified' : `INR ${impact.toLocaleString('en-IN')}`],
        ['Approved amount', r.approved_amount == null ? '—' : `INR ${r.approved_amount}`],
      ].filter(([label]) => !['cash_discount', 'grn_delay_waiver', 'surplus_fabric_consumption'].includes(r.request_type) || label !== 'Approved amount') as [string, string][]),
      ['Decision by', r.decided_by ?? r.approved_by ?? 'Awaiting decision'],
      ['Decision at (IST)', stamp(r.decided_at ?? r.approved_at)],
      ['Decision remarks', r.decision_notes || r.rejection_notes || r.rework_notes || '—'],
      [isHold ? 'Waiver completion' : 'Finance processing', r.processing_status === 'processed' ? `${isHold ? 'Completed' : `Processed · INR ${r.processed_amount}`} · ${r.processed_reference} · ${r.processed_by} · ${stamp(r.processed_at)}` : r.status === 'approved' ? (isHold ? 'Pending waiver completion' : 'Pending Finance action') : 'Available after approval'],
    ] },
  ];
  return <Container className="commercial-review">
    {!standalone && <summary>View details / history{admin ? ' / review' : ''}</summary>}
    <div className="commercial-review-grid">{groups.map((group) => <section className={`commercial-review-card${group.title === 'Request details' || group.title === 'Hold and waiver details' ? ' commercial-review-card-hold' : ''}`} key={group.title}><h3>{group.title}</h3><dl>{group.rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>)}</div>
    {r.attachments.length > 0 && <section className="commercial-review-documents"><h3>Supporting documents</h3><div className="commercial-review-files">{r.attachments.map((file) => <button key={file.path} className="wf-btn wf-btn-ghost" disabled={pending} onClick={() => start(async () => {
      try { const result = await signCommercialFile(r.id, file.path); if ('url' in result) window.open(result.url, '_blank', 'noopener,noreferrer'); else setError(result.error); }
      catch { setError('Could not open this attachment. Try again.'); }
    })}>{file.name}</button>)}</div></section>}
    {error && !admin && <p role="alert">{error}</p>}
    {admin && <div className={`commercial-review-actions${isHold || ['cost_increment', 'dn_removal', 'grn_delay_waiver', 'surplus_fabric_consumption'].includes(r.request_type) ? ' commercial-review-actions-stacked' : ''}`}>
      {isHold && ['pending_l2', 'submitted'].includes(r.status) && <label>Waiver days to approve<input className="commercial-waiver-days" readOnly value={waiverDays ?? ''} /><small>Calculated from hold end date − hold start date.</small></label>}
      {r.request_type === 'grn_delay_waiver' && <label>GRN Delay Days<input className="commercial-waiver-days" readOnly value={grnDelayDays(r.details ?? {}) ?? ''} /><small>Calculated from GRN date − goods delivery date.</small></label>}
      {r.request_type === 'surplus_fabric_consumption' && <><label>Increased Fabric Consumption<input className="commercial-waiver-days" readOnly value={consumptionIncrease?.amount ?? ''} /><small>Calculated from revised fabric consumption − initial average fabric consumption.</small></label><label>Fabric Consumption Increase (%)<input className="commercial-waiver-days" readOnly value={consumptionIncrease ? `${consumptionIncrease.percent}%` : ''} /><small>Increase divided by initial average fabric consumption × 100.</small></label></>}
      {(r.request_type === 'cost_increment' || r.request_type === 'dn_removal') && ['pending_l2', 'submitted'].includes(r.status) && <label>Approved amount (INR)<input className="commercial-approved-amount" type="number" min="0" step="0.01" value={approved} onChange={(e) => setApproved(e.target.value)} /></label>}
      <label>Decision reason / processing note<textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></label>
      {['pending_l2', 'submitted'].includes(r.status) && <>
        {!isHold && !['cost_increment', 'dn_removal', 'cash_discount', 'grn_delay_waiver', 'surplus_fabric_consumption'].includes(r.request_type) && <label>Approved amount (INR)<input className="commercial-approved-amount" type="number" min="0" step="0.01" value={approved} onChange={(e) => setApproved(e.target.value)} /></label>}
        <div className="wf-footer-actions"><button className="wf-btn wf-btn-primary" disabled={pending} onClick={() => act('approve')}>Approve</button><button className="wf-btn wf-btn-ghost" disabled={pending} onClick={() => act('reject')}>Reject</button></div>
      </>}
      {r.status === 'approved' && r.processing_status !== 'processed' && <>
        {!isHold && <label>Processed amount (INR)<input type="number" min="0" step="0.01" value={processed} onChange={(e) => setProcessed(e.target.value)} /></label>}
        <label>{isHold ? 'Waiver completion reference' : 'Payment / adjustment document reference'}<input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={200} /></label>
        <div className="wf-footer-actions"><button className="wf-btn wf-btn-primary" disabled={pending} onClick={() => act('process')}>{isHold ? 'Mark waiver completed' : 'Mark processed'}</button><button className="wf-btn wf-btn-ghost" disabled={pending} onClick={() => act('reopen')}>Reopen for amendment</button></div>
      </>}
      {error && <p role="alert">{error}</p>}
    </div>}
    <details><summary>Revision history ({events.length})</summary>
      {events.map((event) => {
        const changed = Object.keys(historyLabels).filter((key) => JSON.stringify(event.before_values?.[key] ?? null) !== JSON.stringify(event.after_values[key] ?? null));
        const beforeDetails = (event.before_values?.details ?? {}) as Record<string, string>;
        const afterDetails = (event.after_values.details ?? {}) as Record<string, string>;
        const detailFields = [...Object.values(COMMERCIAL_EXTRA_FIELDS).flat(), { key: 'approved_waiver_days', label: 'Approved waiver days' }].filter((field, index, fields) => fields.findIndex((f) => f.key === field.key) === index && beforeDetails[field.key] !== afterDetails[field.key]);
        return <div key={event.id}><strong>{stamp(event.occurred_at)} · {event.actor_email}</strong><ul>{changed.map((key) => <li key={key}>{historyLabels[key]}: {historyValue(key, event.before_values?.[key])} → {historyValue(key, event.after_values[key])}</li>)}{detailFields.map((field) => <li key={field.key}>{field.label}: {beforeDetails[field.key] || '—'} → {afterDetails[field.key] || '—'}</li>)}</ul></div>;
      })}
      {!events.length && <p>No revision events recorded yet. Legacy requests retain their existing decision stamps.</p>}
    </details>
  </Container>;
}

export function CommercialAccounts({ accounts, vendors }: { accounts: CommercialAccount[]; vendors: { vendor_code: string; vendor_name: string | null }[] }) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'create' | 'manage'>('create');
  const id = useId();
  function selectMode(next: 'create' | 'manage') { setMode(next); setMessage(''); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || pending) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'create' : event.key === 'End' ? 'manage' : mode === 'create' ? 'manage' : 'create';
    selectMode(next);
    event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-mode="${next}"]`)?.focus();
  }
  return <details className="panel commercial-accounts"><summary><span>Vendor portal access</span><span className="commercial-accounts-count">{accounts.length} {accounts.length === 1 ? 'login' : 'logins'}</span></summary>
    <div className="commercial-accounts-body">
    <p className="commercial-accounts-intro">Create and manage vendor logins. <a href="/commercial-requests/login" target="_blank" rel="noopener noreferrer">Open vendor login ↗</a></p>
    <div className="commercial-account-tabs" role="tablist" aria-label="Vendor account setup">
      {(['create', 'manage'] as const).map((tab) => <button key={tab} id={`${id}-${tab}`} type="button" role="tab" data-mode={tab} aria-selected={mode === tab} aria-controls={`${id}-panel`} tabIndex={mode === tab ? 0 : -1} disabled={pending} onClick={() => selectMode(tab)} onKeyDown={tabKey}>{tab === 'create' ? 'Create vendor login' : 'Manage existing access'}</button>)}
    </div>
    <div className="commercial-account-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${mode}`}>
    <p className="commercial-accounts-note" id={`${id}-help`}>{mode === 'create' ? 'Use a temporary password of at least 12 characters. Vendors must change it on their first password sign-in. Share it securely; no invitation email is sent.' : 'Choose the vendor and access status for an existing login email. The account password stays unchanged.'}</p>
    <form action={(fd) => start(async () => {
      try { const result = await (mode === 'create' ? createCommercialVendorLogin(fd) : linkCommercialVendor(fd)); if (result.ok) reloadWithToast(result.message); else setMessage(result.error); }
      catch { setMessage('Could not update vendor access.'); }
    })} key={mode} className="commercial-accounts-form" data-mode={mode} aria-describedby={`${id}-help`}>
      {mode === 'create' && <label><span>Contact name</span><input name="full_name" placeholder="Vendor contact name" required maxLength={200} autoComplete="off" disabled={pending} /></label>}
      <label><span>Vendor login email</span><input name="email" type="email" placeholder="name@example.com" required autoComplete="off" disabled={pending} /></label>
      {mode === 'create' && <label><span>Temporary password</span><input name="password" type="password" placeholder="At least 12 characters" required minLength={12} maxLength={128} autoComplete="new-password" disabled={pending} /></label>}
      <label><span>Vendor</span><select name="vendor_code" required disabled={pending}><option value="">Select vendor…</option>{vendors.map((v) => <option key={v.vendor_code} value={v.vendor_code}>{v.vendor_code} · {v.vendor_name}</option>)}</select></label>
      {mode === 'manage' && <label><span>Access</span><select name="is_active" disabled={pending}><option value="true">Active</option><option value="false">Disabled</option></select></label>}
      <div className="commercial-accounts-footer"><button className="wf-btn wf-btn-primary" disabled={pending}>{pending ? 'Saving…' : mode === 'create' ? 'Create login and grant access' : 'Save vendor access'}</button></div>
    </form>
    {message && <p className="commercial-accounts-error" role="alert">{message}</p>}
    </div>
    {accounts.length > 0 && <div className="commercial-existing-accounts"><h4>Existing vendor logins</h4><ul>{accounts.map((a) => <li key={a.user_id}><span>{a.email}</span><span className="commercial-account-code">{a.vendor_code}</span><span className={`commercial-account-status${a.is_active ? ' is-active' : ''}`}>{a.is_active ? 'Active' : 'Disabled'}</span></li>)}</ul></div>}
    </div>
  </details>;
}
