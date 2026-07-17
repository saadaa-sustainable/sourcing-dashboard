-- Open dashboard access to any authenticated user, regardless of email domain.
-- This intentionally removes the previous @saadaa.in-only restriction at both
-- the auth layer (email-domain trigger) and the data layer (RLS policies).
-- Accounts remain invite-only, created through the admin user panel.

-- 1. Remove email-domain enforcement so any email can hold an account.
drop trigger if exists enforce_saadaa_email_domain on auth.users;
drop function if exists auth.enforce_saadaa_email_domain();

-- 2. Replace the domain-restricted read policies with authenticated-only ones.
--    RLS stays enabled and grants remain SELECT-only; the service role still
--    bypasses RLS for sheet-sync writes.
drop policy if exists "saadaa employees can read pending POs" on public.pending_po_master;
drop policy if exists "saadaa employees can read vendor types" on public.vendor_type_master;
drop policy if exists "saadaa employees can read vendor capacity" on public.vendor_master_data;
drop policy if exists "saadaa employees can read TNA" on public.tna_tracker;
drop policy if exists "saadaa employees can read sync logs" on public.sync_log;

create policy "authenticated can read pending POs"
  on public.pending_po_master for select to authenticated using (true);
create policy "authenticated can read vendor types"
  on public.vendor_type_master for select to authenticated using (true);
create policy "authenticated can read vendor capacity"
  on public.vendor_master_data for select to authenticated using (true);
create policy "authenticated can read TNA"
  on public.tna_tracker for select to authenticated using (true);
create policy "authenticated can read sync logs"
  on public.sync_log for select to authenticated using (true);
