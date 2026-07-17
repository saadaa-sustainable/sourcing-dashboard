import { ArrowRight, LockKeyhole } from 'lucide-react';
import { redirect } from 'next/navigation';
import { hasSupabaseEnv } from '@/lib/supabase/server';
import { login } from './actions';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (!hasSupabaseEnv()) redirect('/');
  const { error } = await searchParams;
  return <main className="login-page"><section className="login-card"><div className="brand login-brand"><div className="brand-mark">S</div><div><strong>SAADAA</strong><span>Sourcing intelligence</span></div></div><div className="login-icon"><LockKeyhole /></div><h1>Welcome back</h1><p>Sign in to view sourcing performance.</p>{error && <div className="login-error">{error}</div>}<form action={login}><label><span>Work email</span><input type="email" name="email" placeholder="you@company.com" required autoComplete="email" /></label><label><span>Password</span><input type="password" name="password" required autoComplete="current-password" /></label><button type="submit">Sign in <ArrowRight size={17}/></button></form><small>Access is available to invited accounts.</small></section></main>;
}
