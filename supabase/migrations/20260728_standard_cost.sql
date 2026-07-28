-- =====================================================================
-- sd_standard_cost — the standard cost sheet (final rates), a new approval
-- entity on the existing engine (sd_approval_log, decideApproval, routeApproval).
--
-- Two-to-three standard costs per product: Job Work (you supply fabric, no fabric
-- margin), FOB (vendor buys fabric, margin included), and E-FOB. The Buying Plan
-- reads the APPROVED rates and computes buying value per PO type:
--   value = job_qty×job_cost + fob_qty×fob_cost + efob_qty×efob_cost
--
-- Save → Submit → Approve (admin). Freezes at first PO issuance for the product
-- (frozen = true), after which the rates can no longer be edited. The full
-- cost-component breakdown ('broken-down' view) is a later layer.
-- =====================================================================

create table if not exists public.sd_standard_cost (
  id              bigserial primary key,
  product_code    text not null unique,
  job_cost        numeric,
  fob_cost        numeric,
  efob_cost       numeric,
  status          public.sd_status not null default 'draft',
  submitted_by    text,
  submitted_at    timestamptz,
  approved_by     text,
  approved_at     timestamptz,
  rejection_notes text,
  frozen          boolean not null default false,   -- locked at first PO issuance
  frozen_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists sd_standard_cost_status_idx on public.sd_standard_cost (status);

-- Seed a row per active product so the sheet is a ready worklist to digitize.
insert into public.sd_standard_cost (product_code)
select distinct product_code
from public.sd_active_variants
where product_code is not null and product_code <> ''
on conflict (product_code) do nothing;

alter table public.sd_standard_cost enable row level security;
grant select, insert, update, delete on public.sd_standard_cost to authenticated;
grant usage, select on sequence public.sd_standard_cost_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost' and policyname='saadaa read sd_standard_cost') then
    execute 'create policy "saadaa read sd_standard_cost" on public.sd_standard_cost
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost' and policyname='sourcing write sd_standard_cost') then
    execute 'create policy "sourcing write sd_standard_cost" on public.sd_standard_cost
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
