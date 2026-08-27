-- The new read-only viewer pages (GRN Detail, DOQ Dataset) read the BASE tables
-- sd_ee_grn and sd_inventory_planning directly. Until now those were reached only
-- through derived views (sd_vendor_grn_reject, sd_doq), so the base tables have no
-- authenticated SELECT grant — the pages would return empty under RLS in prod.
--
-- Grant SELECT to authenticated and ensure a saadaa-only RLS policy exists, matching
-- every other exposed table (sd_ee_grn already got its policy in 20260817150000 but
-- never a grant; sd_inventory_planning had neither). The service_role sync bypasses
-- RLS, and the existing definer views over these tables are unaffected.
-- (vendor_master_data is already granted — see 20260715101226 — so Vendor Master
-- needs nothing here.)

-- sd_ee_grn: policy exists, add the missing grant.
grant select on public.sd_ee_grn to authenticated;

-- sd_inventory_planning: enable RLS + grant + saadaa policy.
alter table public.sd_inventory_planning enable row level security;
grant select on public.sd_inventory_planning to authenticated;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'sd_inventory_planning'
      and policyname = 'sd_inventory_planning_read'
  ) then
    create policy sd_inventory_planning_read on public.sd_inventory_planning
      for select to authenticated using (public.sd_is_saadaa());
  end if;
end $$;
