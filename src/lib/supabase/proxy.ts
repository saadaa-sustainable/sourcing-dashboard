import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

export async function updateSession(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === 'string' ? data.claims.email.toLowerCase() : '';
  // External vendor sessions belong only in their portal. The internal dashboard has
  // legacy read paths designed for company accounts; do not admit vendor sessions there.
  const path = request.nextUrl.pathname;
  if (email && !email.endsWith('@saadaa.in') && path !== '/commercial-requests' && !path.startsWith('/commercial-requests/')) {
    const blocked = request.method === 'GET' || request.method === 'HEAD'
      ? NextResponse.redirect(new URL('/commercial-requests', request.url))
      : NextResponse.json({ error: 'Vendor sessions may access only Commercial Requests.' }, { status: 403 });
    response.cookies.getAll().forEach((cookie) => blocked.cookies.set(cookie));
    return blocked;
  }
  return response;
}
