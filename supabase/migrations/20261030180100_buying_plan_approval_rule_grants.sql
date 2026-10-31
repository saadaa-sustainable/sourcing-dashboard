-- Override broad project defaults: RLS protects DML; TRUNCATE must not be exposed.
revoke all privileges on table public.sd_buying_plan_approval_rule from public, anon, authenticated;
grant select, insert, update, delete on table public.sd_buying_plan_approval_rule to authenticated;
