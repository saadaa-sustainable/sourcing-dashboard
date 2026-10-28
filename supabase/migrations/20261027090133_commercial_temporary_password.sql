-- A temporary-password JWT may not read request data through the Data API.
-- Auth app_metadata is controlled only by trusted server-side admin operations.
alter policy commercial_request_read on public.sd_vendor_commercial_request using (
  exists(select 1 from public.sd_user u
    where lower(u.email) = lower(auth.jwt()->>'email') and u.is_active and lower(u.email) like '%@saadaa.in')
  or (
    coalesce(auth.jwt()->'app_metadata'->>'commercial_password_change_required', 'false') = 'false'
    and exists(select 1 from public.sd_commercial_vendor_account a
      where a.user_id = auth.uid() and a.is_active and a.vendor_code = sd_vendor_commercial_request.vendor_code)
  )
);
notify pgrst, 'reload schema';
