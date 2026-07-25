-- =====================================================================
-- Reconcile an EXISTING sd_user table (already seeded with the original
-- 5-role model) to the two-role model, and add pushpendra@saadaa.in as the
-- admin / role manager.
--
-- ⚠️  RUN IN TWO STEPS. Postgres will not let you ADD an enum value and USE it
--     in the same transaction. Run STEP 1 on its own, then STEP 2.
--     (If you paste both at once and get "unsafe use of new value team",
--      just run STEP 1 first, then STEP 2.)
-- =====================================================================

-- ------------------------------ STEP 1 -------------------------------
alter type public.sd_role add value if not exists 'team';

-- ------------------------------ STEP 2 -------------------------------
-- Old roles -> two-role model. approver_l2 (top approver) becomes admin;
-- approver_l1 and supply_chain become team.
update public.sd_user set role = 'admin' where role::text = 'approver_l2';
update public.sd_user set role = 'team'  where role::text in ('approver_l1', 'supply_chain');

-- The role manager.
insert into public.sd_user (email, full_name, role) values
  ('pushpendra@saadaa.in', 'Pushpendra (role manager)', 'admin')
on conflict (email) do update set role = 'admin', is_active = true;

-- Write access = the two working roles (was: supply_chain/approver_l1/l2/admin).
create or replace function public.sd_can_write()
returns boolean
language sql stable
as $$
  select public.sd_is_saadaa()
     and public.sd_current_role() in ('team', 'admin');
$$;

-- Let admins manage users from the in-app User Panel (add if missing).
grant insert, update on public.sd_user to authenticated;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sd_user'
      and policyname = 'admin manage users'
  ) then
    execute 'create policy "admin manage users" on public.sd_user
               for all to authenticated
               using (public.sd_current_role() = ''admin'')
               with check (public.sd_current_role() = ''admin'')';
  end if;
end $$;

-- Verify:
--   select email, role, is_active from public.sd_user order by role, email;
