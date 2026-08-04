-- Security hardening for the access-control helper functions (Supabase advisors
-- lints 0011 + 0028). Behaviour is unchanged.
--
-- 1. Pin search_path on the two gate functions that lacked it. Both reference
--    only schema-qualified objects (auth.jwt(), public.sd_*) and pg_catalog
--    built-ins, so an empty search_path is safe and blocks search_path attacks.
alter function public.sd_is_saadaa() set search_path = '';
alter function public.sd_can_write() set search_path = '';

-- 2. sd_current_role() is SECURITY DEFINER and reads public.sd_user. The anon
--    (unauthenticated) role has no business calling it, so revoke EXECUTE from
--    anon and PUBLIC. `authenticated` MUST keep EXECUTE: sd_can_write() is
--    SECURITY INVOKER and calls sd_current_role() inside the write RLS policies,
--    so the signed-in caller needs the privilege.
revoke execute on function public.sd_current_role() from anon, public;
