-- =====================================================================
-- Standard Cost — rich cost record (PR1).
--
-- Turns the flat FG standard-cost row into a documented costing record: CM
-- (stitching) cost, an entered Total PO Average Cost, CAD / RFP document links,
-- and a `documented` flag so a product that was never costed reads as a real
-- data gap (not a silent blank). Colour/size costing lives in a detail table.
--
-- The existing job/fob/efob rates are UNTOUCHED — the Buying Plan still values
-- from them. This is an additive documentation layer.
-- =====================================================================

alter table public.sd_standard_cost add column if not exists cm_cost           numeric;
alter table public.sd_standard_cost add column if not exists total_po_avg_cost numeric;
alter table public.sd_standard_cost add column if not exists cad_link          text;
alter table public.sd_standard_cost add column if not exists rfp_link          text;
alter table public.sd_standard_cost add column if not exists documented        boolean not null default false;

-- Rows that already carry a rate are documented; the empty seeds stay gaps.
update public.sd_standard_cost
   set documented = true
 where documented = false
   and (job_cost is not null or fob_cost is not null or efob_cost is not null);

-- Colour-wise / size-wise costing (the detail shown when a record is expanded).
create table if not exists public.sd_standard_cost_line (
  id           bigserial primary key,
  product_code text not null,
  colour       text,
  size         text,
  fabric_cost  numeric,
  cm_cost      numeric,
  total_cost   numeric,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (product_code, colour, size)
);
create index if not exists sd_standard_cost_line_code_idx
  on public.sd_standard_cost_line (product_code);

alter table public.sd_standard_cost_line enable row level security;
grant select, insert, update, delete on public.sd_standard_cost_line to authenticated;
grant usage, select on sequence public.sd_standard_cost_line_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_line' and policyname='saadaa read sd_standard_cost_line') then
    execute 'create policy "saadaa read sd_standard_cost_line" on public.sd_standard_cost_line
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_standard_cost_line' and policyname='sourcing write sd_standard_cost_line') then
    execute 'create policy "sourcing write sd_standard_cost_line" on public.sd_standard_cost_line
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
