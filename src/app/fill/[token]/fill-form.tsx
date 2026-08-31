'use client';

import { useState, useTransition } from 'react';
import { submitCuttingViaLink } from '@/lib/forms/actions';

export function FillForm({
  token,
  bomQty,
  bomUom,
}: {
  token: string;
  bomQty: number | null;
  bomUom: string | null;
}) {
  const [name, setName] = useState('');
  const [contact, setContact] = useState('');
  const [actual, setActual] = useState('');
  const [date, setDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function submit() {
    setErr(null);
    if (!name.trim() || !contact.trim()) return setErr('Enter your name and email/phone.');
    if (actual === '') return setErr('Enter the actual consumption.');
    const fd = new FormData();
    fd.set('token', token);
    fd.set('name', name);
    fd.set('contact', contact);
    fd.set('actual_consumption_qty', actual);
    fd.set('cutting_date', date);
    fd.set('remarks', remarks);
    start(async () => {
      const res = await submitCuttingViaLink(fd);
      if (res.ok) setDone(true);
      else setErr(res.error);
    });
  }

  if (done) {
    return (
      <div className="fill-done">
        <h2>Submitted ✓</h2>
        <p>Thank you — your cutting entry has been recorded. You can close this page.</p>
      </div>
    );
  }

  return (
    <div className="fill-form">
      <label className="fill-field">
        <span>BOM standard</span>
        <input value={bomQty != null ? `${bomQty}${bomUom ? ' ' + bomUom : ''}` : 'No BOM on file'} readOnly disabled />
      </label>
      <label className="fill-field">
        <span>Actual consumption *</span>
        <input type="number" min={0} step="0.01" value={actual} onChange={(e) => setActual(e.target.value)} />
      </label>
      <label className="fill-field">
        <span>Cutting date</span>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label className="fill-field">
        <span>Your name *</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="fill-field">
        <span>Email or phone *</span>
        <input value={contact} onChange={(e) => setContact(e.target.value)} />
      </label>
      <label className="fill-field">
        <span>Remarks</span>
        <textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </label>

      {err && <p className="fill-error">{err}</p>}
      <button type="button" className="fill-submit" disabled={busy} onClick={submit}>
        {busy ? 'Submitting…' : 'Submit'}
      </button>
    </div>
  );
}
