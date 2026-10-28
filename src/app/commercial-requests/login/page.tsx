import { vendorCommercialLogin } from '../session-actions';
import '../../vendor-commercial/commercial.css';
import { GoogleButton } from '@/app/login/google-button';

export default async function VendorLogin({ searchParams }: { searchParams: Promise<{ error?: string; message?: string }> }) {
  const { error, message } = await searchParams;
  return <main className="commercial-portal ui-shopify commercial-login"><section className="panel commercial-login-card">
    <header><span className="commercial-login-brand">SAADAA · Vendor portal</span><h1>Commercial requests</h1><p>Sign in with your registered vendor account.</p></header>
    {error && <p className="commercial-login-error" role="alert">{error}</p>}
    {message && <p className="commercial-login-success" role="status">{message}</p>}
    <div className="commercial-login-google"><GoogleButton vendor /><p>Use the Google account registered with SAADAA.</p></div>
    <div className="commercial-login-divider"><span>or sign in with email</span></div>
    <form action={vendorCommercialLogin} className="commercial-login-form">
      <label><span>Email address</span><input name="email" type="email" placeholder="name@example.com" autoComplete="username" required /></label>
      <label><span>Password</span><input name="password" type="password" placeholder="Enter your password" autoComplete="current-password" required /></label>
      <button className="wf-btn wf-btn-primary">Sign in</button>
    </form><p className="commercial-login-help">Need access or password help? Contact your SAADAA representative.</p>
  </section></main>;
}
