import { NextResponse } from 'next/server';
import { createClient, hasSupabaseEnv } from '@/lib/supabase/server';

// OAuth (Google) redirect target. Supabase sends the user here with a `?code`
// after Google sign-in; we exchange it for a session, then enforce the
// @saadaa.in domain before letting them in.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const oauthError = searchParams.get('error_description') ?? searchParams.get('error');

  if (oauthError) return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(oauthError.replace(/\+/g, ' '))}`);
  if (!hasSupabaseEnv() || !code) return NextResponse.redirect(`${origin}/login`);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);

  const email = data.user?.email?.toLowerCase() ?? '';
  if (!email.endsWith('@saadaa.in')) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('Only @saadaa.in accounts can access this dashboard.')}`);
  }

  return NextResponse.redirect(`${origin}/`);
}
