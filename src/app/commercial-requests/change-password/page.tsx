import { redirect } from 'next/navigation';
import { commercialIdentity } from '@/lib/commercial-access.server';
import { vendorCommercialSignOut } from '../session-actions';
import { ChangePasswordForm } from './password-form';
import '../../vendor-commercial/commercial.css';

export default async function ChangePasswordPage() {
  const actor = await commercialIdentity();
  if (!actor) redirect('/commercial-requests/login');
  if (!actor.vendorCode) redirect('/vendor-commercial');
  if (!actor.passwordChangeRequired) redirect('/commercial-requests');
  return <main className="commercial-portal ui-shopify commercial-login commercial-password"><section className="panel commercial-login-card">
    <header><span className="commercial-login-brand">SAADAA · Vendor portal</span>
    <h1>Set your own password</h1>
    <p className="commercial-password-email">{actor.email}</p>
    <p>Choose a new password to replace your temporary password and access Commercial Requests.</p></header>
    <ChangePasswordForm />
    <form className="commercial-password-signout" action={vendorCommercialSignOut}><button className="wf-btn wf-btn-ghost">Sign out</button></form>
  </section></main>;
}
