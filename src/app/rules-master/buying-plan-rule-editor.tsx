'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { SdUser } from '@/lib/forms/types';
import type { BuyingPlanApprovalRule } from '@/lib/buying-plan-approval';
import { saveBuyingPlanApprovalRule } from './buying-plan-rule-actions';

export function BuyingPlanRuleEditor({ rule, users }: {
  rule: BuyingPlanApprovalRule | null;
  users: Pick<SdUser, 'email' | 'full_name' | 'role' | 'is_active'>[];
}) {
  const router = useRouter();
  const [l1, setL1] = useState(rule?.l1_email ?? '');
  const [l2, setL2] = useState(rule?.l2_email ?? '');
  const [value, setValue] = useState(rule ? String(rule.max_value) : '');
  const [message, setMessage] = useState('');
  const [resultTone, setResultTone] = useState<'success' | 'error'>('success');
  const [configured, setConfigured] = useState(Boolean(rule));
  const [pending, start] = useTransition();
  const eligible = users.filter(user => user.is_active && user.role !== 'viewer');

  return (
    <section className="panel wf-rule-group bp-approval-rule-panel">
      <div className="wf-rule-group-head bp-approval-rule-heading">
        <div>
          <h3>Buying Plan approval</h3>
          <p>Choose approvers and the L1 value limit for FG and Fabric / Material plans.</p>
        </div>
        <span className={`bp-approval-rule-badge${configured ? ' is-configured' : ''}`}>
          {configured ? 'Configured' : 'Not configured'}
        </span>
      </div>
      <form className="bp-approval-rule-form" onSubmit={event => {
        event.preventDefault();
        setMessage('');
        const form = new FormData();
        form.set('l1_email', l1);
        form.set('l2_email', l2);
        form.set('max_value', value);
        start(async () => {
          const result = await saveBuyingPlanApprovalRule(form);
          setResultTone(result.ok ? 'success' : 'error');
          setMessage(result.ok ? 'Approval rule saved.' : result.error ?? 'Could not save.');
          if (result.ok) { setConfigured(true); router.refresh(); }
        });
      }}>
        <div className="bp-approval-rule-grid">
          {[
            { id: 'bp-rule-l1', label: 'L1 approver', value: l1, set: setL1, other: l2, hint: 'Can approve up to the configured value limit.' },
            { id: 'bp-rule-l2', label: 'L2 approver', value: l2, set: setL2, other: l1, hint: 'L2 can approve any plan value, including L1 plans.' },
          ].map(field => (
            <div className="bp-approval-rule-field" key={field.id}>
              <label htmlFor={field.id}>{field.label} <span className="bp-approval-rule-required" aria-label="required">*</span></label>
              <select id={field.id} required value={field.value} onChange={event => field.set(event.target.value)} disabled={pending} aria-describedby={`${field.id}-hint`}>
                <option value="">Select a dashboard user</option>
                {field.value && !eligible.some(user => user.email === field.value) && <option value={field.value} disabled>{field.value} (unavailable)</option>}
                {eligible.map(user => <option key={user.email} value={user.email} disabled={user.email === field.other}>{user.full_name ? `${user.full_name} - ${user.email}` : user.email}</option>)}
              </select>
              <p id={`${field.id}-hint`}>{field.hint}</p>
            </div>
          ))}
          <div className="bp-approval-rule-field">
            <label htmlFor="bp-rule-value">Maximum plan value for L1 (INR) <span className="bp-approval-rule-required" aria-label="required">*</span></label>
            <input id="bp-rule-value" required type="number" min="0" max="1000000000000" step="0.01" placeholder="e.g. 100000" value={value} onChange={event => setValue(event.target.value)} disabled={pending} aria-describedby="bp-rule-value-hint" />
            <p id="bp-rule-value-hint">At or below: L1 or L2. Above this amount: L2 only.</p>
          </div>
        </div>
        <div className="bp-approval-rule-note">Unknown plan values require L2. Changes apply to pending plans; approved and closed-month plans retain their existing locks.</div>
        <div className="bp-approval-rule-footer">
          <p className="bp-approval-rule-meta">{!configured ? 'Existing routing remains until a rule is saved.' : rule?.updated_by ? `Last updated by ${rule.updated_by}` : 'Approval rule configured.'}</p>
          <button className="wf-btn wf-btn-primary bp-approval-rule-save" disabled={pending} type="submit">{pending ? 'Saving...' : 'Save approval rule'}</button>
        </div>
        {message && <p className={`bp-approval-rule-result is-${resultTone}`} role={resultTone === 'error' ? 'alert' : 'status'}>{message}</p>}
      </form>
    </section>
  );
}
