-- The Sync Health view timed out in prod: with security_invoker the RLS check
-- (sd_is_saadaa()) runs per row while counting 170k+ row tables, pushing the
-- query to ~7.8s against the authenticated role's 8s statement timeout.
-- The view only exposes row counts and refresh timestamps, so let it run with
-- owner rights (RLS bypassed); access stays limited to authenticated via grant.
alter view public.sd_sync_status set (security_invoker = false);
