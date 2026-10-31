-- Buying Plan-specific approval settings; no default users or monetary threshold invented.
create table public.sd_buying_plan_approval_rule (
 id integer primary key check(id=1),
 l1_email text not null references public.sd_user(email),
 l2_email text not null references public.sd_user(email),
 max_value numeric(18,2) not null check(max_value>=0 and max_value<=1000000000000),
 updated_by text not null,
 updated_at timestamptz not null default now(),
 check(l1_email<>l2_email),
 check(l1_email=lower(btrim(l1_email)) and l2_email=lower(btrim(l2_email)))
);
alter table public.sd_buying_plan_approval_rule enable row level security;
create policy "saadaa read buying plan approval rule" on public.sd_buying_plan_approval_rule for select to authenticated using(public.sd_is_saadaa());
create policy "admin manage buying plan approval rule" on public.sd_buying_plan_approval_rule for all to authenticated using(public.sd_current_role()='admin') with check(public.sd_current_role()='admin');
grant select,insert,update,delete on public.sd_buying_plan_approval_rule to authenticated;
