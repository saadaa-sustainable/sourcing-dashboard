/** Accept only verified Supabase JWT claims, never user_metadata or a URL flag. */
export function isCommercialGoogleSession(claims: unknown, uid: string): boolean {
  if (!claims || typeof claims !== 'object') return false;
  const jwt = claims as { sub?: string; amr?: { method?: string }[]; app_metadata?: { provider?: string; providers?: string[] } };
  return jwt.sub === uid && Array.isArray(jwt.amr) && jwt.amr.some((entry) => entry?.method === 'oauth')
    && (jwt.app_metadata?.provider === 'google' || (Array.isArray(jwt.app_metadata?.providers) && jwt.app_metadata.providers.includes('google')));
}
