-- =====================================================================
-- Custom roles with per-role view sets, managed from the User Panel.
--
-- The base sd_user.role (viewer/team/admin) stays the APPROVAL ladder and is
-- unchanged. Custom roles are about WHAT A PERSON SEES: each role carries a set
-- of route paths (views), a user can hold several roles, and their visible
-- pages are the union. A user with no custom roles keeps today's behaviour
-- (every non-admin-only page); admins always see everything.
-- =====================================================================

create table public.sd_custom_role (
  id          bigint generated always as identity primary key,
  name        text not null unique,
  description text,
  pages       text[] not null default '{}',   -- route paths from the views registry
  created_at  timestamptz not null default now()
);

create table public.sd_user_role (
  user_email text not null references public.sd_user(email) on delete cascade,
  role_id    bigint not null references public.sd_custom_role(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_email, role_id)
);

alter table public.sd_custom_role enable row level security;
alter table public.sd_user_role   enable row level security;

-- Everyone signed in reads (the nav needs the caller's own roles); only the
-- admin (role manager) writes — same gate as managing sd_user itself.
create policy "saadaa read sd_custom_role" on public.sd_custom_role
  for select to authenticated using (public.sd_is_saadaa());
create policy "admin manage sd_custom_role" on public.sd_custom_role
  for all to authenticated
  using (public.sd_current_role() = 'admin')
  with check (public.sd_current_role() = 'admin');

create policy "saadaa read sd_user_role" on public.sd_user_role
  for select to authenticated using (public.sd_is_saadaa());
create policy "admin manage sd_user_role" on public.sd_user_role
  for all to authenticated
  using (public.sd_current_role() = 'admin')
  with check (public.sd_current_role() = 'admin');

grant select on public.sd_custom_role, public.sd_user_role to authenticated;
grant insert, update, delete on public.sd_custom_role, public.sd_user_role to authenticated;
