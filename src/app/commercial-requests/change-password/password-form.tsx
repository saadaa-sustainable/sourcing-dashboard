'use client';
import { useId, useState, useTransition } from 'react';
import { changeVendorTemporaryPassword } from '../session-actions';

export function ChangePasswordForm() {
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const helpId = useId();
  return <form className="commercial-login-form commercial-password-form" action={(fd) => start(async () => {
    setError('');
    try {
    const result = await changeVendorTemporaryPassword(fd);
    if (result && !result.ok) setError(result.error);
    } catch { setError('Could not change your password. Please try again.'); }
  })}>
    <label>Current temporary password<input type="password" name="current_password" autoComplete="current-password" placeholder="Enter your temporary password" required disabled={pending} /></label>
    <label>New password<input type="password" name="new_password" autoComplete="new-password" placeholder="Create a new password" aria-describedby={helpId} minLength={12} maxLength={128} required disabled={pending} /></label>
    <label>Confirm new password<input type="password" name="confirm_password" autoComplete="new-password" placeholder="Re-enter your new password" aria-describedby={helpId} minLength={12} maxLength={128} required disabled={pending} /></label>
    <p id={helpId} className="commercial-password-help">Use 12–128 characters and a password different from your temporary password.</p>
    {error && <p className="commercial-login-error" role="alert">{error}</p>}
    <button className="wf-btn wf-btn-primary" disabled={pending}>{pending ? 'Updating…' : 'Change password'}</button>
  </form>;
}
