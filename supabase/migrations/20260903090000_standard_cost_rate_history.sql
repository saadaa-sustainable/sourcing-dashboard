-- =====================================================================
-- Standard Cost rate history — every ACCEPTED job/FOB/E-FOB rate over time.
--
-- Cost proposal is no longer a one-time event: a signed-off product can be
-- re-proposed and re-accepted. Each acceptance appends a row here (the prior
-- accepted rate is preserved, dated). The LATEST history row per product is the
-- live rate the Buying Plan values from — so re-negotiating a product does NOT
-- disturb the current rate until a new proposal is accepted.
--
-- Buying-plan snapshotting: a plan reflects the latest accepted rate while it is
-- a draft; on submit-for-approval each line's standard_value is frozen, so later
-- rate changes never rewrite an in-flight or approved plan.
-- =====================================================================

create table if not exists public.sd_standard_cost_rate_history (
  id           bigint generated always as identity primary key,
  product_code text not null,
  job_cost     numeric,
  fob_cost     numeric,
  efob_cost    numeric,
  accepted_by  text,
  accepted_at  timestamptz not null default now(),
  note         text
);

create index if not exists sd_standard_cost_rate_history_code_idx
  on public.sd_standard_cost_rate_history (product_code, accepted_at desc);

alter table public.sd_standard_cost_rate_history enable row level security;
grant select, insert on public.sd_standard_cost_rate_history to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_rate_history' and policyname='saadaa read sd_standard_cost_rate_history') then
    execute 'create policy "saadaa read sd_standard_cost_rate_history" on public.sd_standard_cost_rate_history
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_rate_history' and policyname='sourcing write sd_standard_cost_rate_history') then
    execute 'create policy "sourcing write sd_standard_cost_rate_history" on public.sd_standard_cost_rate_history
               for insert to authenticated with check (public.sd_can_write())';
  end if;
end $$;

-- Seed from the current approved FG standard costs so the live rate survives the
-- switch to history-as-source-of-truth (no product loses its rate).
insert into public.sd_standard_cost_rate_history
  (product_code, job_cost, fob_cost, efob_cost, accepted_by, accepted_at, note)
select product_code, job_cost, fob_cost, efob_cost,
       approved_by, coalesce(approved_at, now()), 'Backfilled from current approved standard cost'
from public.sd_standard_cost
where status = 'approved'
  and not exists (
    select 1 from public.sd_standard_cost_rate_history h where h.product_code = sd_standard_cost.product_code
  );
