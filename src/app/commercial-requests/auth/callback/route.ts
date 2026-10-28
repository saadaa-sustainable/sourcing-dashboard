import { NextResponse } from 'next/server';
import { createSessionClient, hasSupabaseEnv } from '@/lib/supabase/server';
import { commercialIdentity } from '@/lib/commercial-access.server';

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const login = (message: string) => NextResponse.redirect(`${origin}/commercial-requests/login?error=${encodeURIComponent(message)}`);
  if (searchParams.has('error')) return login('Google sign-in was cancelled or could not be completed. Please retry.');
  const code = searchParams.get('code');
  if (!code || !hasSupabaseEnv()) return login('Google sign-in could not be completed. Please retry.');
  const session = await createSessionClient();
  const { error } = await session.auth.exchangeCodeForSession(code);
  if (error) return login('Google sign-in could not be completed. Please retry.');
  let actor = null;
  try { actor = await commercialIdentity(); } catch { /* Fail closed on account/identity lookup failures. */ }
  if (!actor?.vendorCode || !actor.googleSession) {
    await session.auth.signOut();
    return login('This Google account does not have active vendor access. Use the email registered with SAADAA or contact your representative.');
  }
  // Fixed destination; do not accept arbitrary next/redirect parameters.
  return NextResponse.redirect(`${origin}/commercial-requests`);
}
