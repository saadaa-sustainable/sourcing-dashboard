-- Restore @saadaa.in-only data access, reversing the earlier open-access
-- migration. Reads are limited to @saadaa.in JWTs.
--
-- NOTE: the original auth.users email-domain trigger is intentionally NOT
-- recreated here. This project locks the `auth` schema (CREATE is denied even
-- in the SQL Editor), so the trigger cannot be applied. Domain access is
-- enforced in the app instead: the password login guard, the Google OAuth
-- callback (auth/callback), the dashboard page guard, and these RLS policies.

drop policy if exists "authenticated can read pending POs" on public.pending_po_master;
drop policy if exists "authenticated can read vendor types" on public.vendor_type_master;
drop policy if exists "authenticated can read vendor capacity" on public.vendor_master_data;
drop policy if exists "authenticated can read TNA" on public.tna_tracker;
drop policy if exists "authenticated can read sync logs" on public.sync_log;

create policy "saadaa employees can read pending POs"
  on public.pending_po_master for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read vendor types"
  on public.vendor_type_master for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read vendor capacity"
  on public.vendor_master_data for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read TNA"
  on public.tna_tracker for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
create policy "saadaa employees can read sync logs"
  on public.sync_log for select to authenticated
  using (lower(coalesce((select auth.jwt()) ->> 'email', '')) like '%@saadaa.in');
