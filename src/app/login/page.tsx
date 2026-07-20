import { ArrowRight, LockKeyhole } from 'lucide-react';
import { redirect } from 'next/navigation';
import { hasSupabaseEnv } from '@/lib/supabase/server';
import { login } from './actions';
import { GoogleButton } from './google-button';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!hasSupabaseEnv()) redirect('/');
  const { error } = await searchParams;
  return <main className="login-page"><section className="login-card">
    <div className="brand login-brand"><div className="brand-mark">S</div><div><strong>SAADAA</strong><span>Sourcing intelligence</span></div></div>
    <div className="login-icon"><LockKeyhole /></div>
    <h1>Welcome back</h1>
    <p>Sign in with your SAADAA account to view sourcing performance.</p>
    {error && <div className="login-error">{error}</div>}
    <GoogleButton />
    <div className="login-divider">or use your work email</div>
    <form action={login}>
      <label><span>Work email</span><input type="email" name="email" placeholder="you@saadaa.in" required autoComplete="email" /></label>
      <label><span>Password</span><input type="password" name="password" required autoComplete="current-password" /></label>
      <button type="submit">Sign in <ArrowRight size={17}/></button>
    </form>
    <small>Access is restricted to @saadaa.in accounts.</small>
  </section></main>;
}
