-- Task 2c: material track gets its own accepted-rate history (mirrors the FG table,
--   minus the CMTP revision log which materials don't have).
-- Task 3: Standard Cost final price drops REJ/OH — margin becomes a single editable
--   Rules Master value (sd_analytics_rule.margin_pct, stored as a percent).

create table if not exists public.sd_material_standard_cost_rate_history (
  id           bigint generated always as identity primary key,
  product_code text not null,
  job_cost     numeric,          -- FOB Fabric rate
  fob_cost     numeric,          -- Billing rate
  efob_cost    numeric,          -- Standard Fabric rate (the EFOB fabric rate we value from)
  accepted_by  text,
  accepted_at  timestamptz not null default now(),
  note         text
);

create index if not exists sd_material_rate_history_code_at_idx
  on public.sd_material_standard_cost_rate_history (product_code, accepted_at desc);

alter table public.sd_material_standard_cost_rate_history enable row level security;

drop policy if exists "saadaa read sd_material_standard_cost_rate_history"
  on public.sd_material_standard_cost_rate_history;
create policy "saadaa read sd_material_standard_cost_rate_history"
  on public.sd_material_standard_cost_rate_history
  for select using (sd_is_saadaa());

drop policy if exists "sourcing write sd_material_standard_cost_rate_history"
  on public.sd_material_standard_cost_rate_history;
create policy "sourcing write sd_material_standard_cost_rate_history"
  on public.sd_material_standard_cost_rate_history
  for insert with check (sd_can_write());

-- Margin % rule (Rules Master). 15% default; final price = garment + margin.
insert into public.sd_analytics_rule (rule_key, value, label, description)
values (
  'margin_pct',
  15,
  'Standard Cost margin %',
  'Margin added on the garment cost (Fabric + CMTP) to get the final price. REJ/OH were removed 2026-09-08; final = garment + this margin.'
)
on conflict (rule_key) do nothing;
