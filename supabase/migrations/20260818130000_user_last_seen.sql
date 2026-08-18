-- Track when each user last used the dashboard, for the admin User Panel.
alter table public.sd_user add column if not exists last_seen_at timestamptz;

-- Stamp the calling user's own last_seen_at. SECURITY DEFINER so a non-admin can update
-- their own row (RLS only lets admins write sd_user), scoped by the JWT email so a user
-- can only ever touch their own row. Throttled to ~5-minute granularity to keep writes
-- negligible even though it is called on every page load.
create or replace function public.sd_touch_last_seen()
returns void
language sql
security definer
set search_path to ''
as $$
  update public.sd_user
     set last_seen_at = now()
   where email = lower(coalesce((select auth.jwt()) ->> 'email', ''))
     and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
$$;

revoke execute on function public.sd_touch_last_seen() from public;
grant execute on function public.sd_touch_last_seen() to authenticated;
