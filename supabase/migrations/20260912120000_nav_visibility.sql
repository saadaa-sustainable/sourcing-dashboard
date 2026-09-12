-- Global sidebar tab visibility. A row is an explicit admin override for one nav path;
-- no row = the path's built-in default (in the sidebar today = shown; extra pages = hidden).
create table if not exists public.sd_nav_visibility (
  path       text primary key,
  visible    boolean not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.sd_nav_visibility enable row level security;

-- Everyone signed in reads it (needed to render their sidebar); writers (admins) manage it.
drop policy if exists "saadaa read sd_nav_visibility" on public.sd_nav_visibility;
create policy "saadaa read sd_nav_visibility" on public.sd_nav_visibility
  for select using (sd_is_saadaa());

drop policy if exists "sourcing write sd_nav_visibility" on public.sd_nav_visibility;
create policy "sourcing write sd_nav_visibility" on public.sd_nav_visibility
  for all using (sd_can_write()) with check (sd_can_write());
