-- Google/OAuth sessions can use mapped vendor access without changing an unused
-- temporary password. Do not clear the flag: password sessions still require change.
alter policy commercial_request_read on public.sd_vendor_commercial_request using (
  exists(select 1 from public.sd_user u
    where lower(u.email) = lower(auth.jwt()->>'email') and u.is_active and lower(u.email) like '%@saadaa.in')
  or (
    (
      coalesce(auth.jwt()->'app_metadata'->>'commercial_password_change_required','false') = 'false'
      or (
        coalesce(auth.jwt()->'amr','[]'::jsonb) @> '[{"method":"oauth"}]'::jsonb
        and (
          auth.jwt()->'app_metadata'->>'provider' = 'google'
          or coalesce(auth.jwt()->'app_metadata'->'providers','[]'::jsonb) @> '["google"]'::jsonb
        )
      )
    )
    and exists(select 1 from public.sd_commercial_vendor_account a
      where a.user_id = auth.uid() and a.is_active and a.vendor_code = sd_vendor_commercial_request.vendor_code)
  )
);
notify pgrst, 'reload schema';
