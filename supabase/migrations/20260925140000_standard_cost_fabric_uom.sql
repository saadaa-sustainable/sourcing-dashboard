-- Standard Cost — how a fabric is consumed: by the metre or by the kilogram.
-- The Fabric Cost master's finished rate reads as INR per metre, but some fabrics are
-- bought and consumed by weight. The team picks the unit per fabric on the cost sheet;
-- the maths (rate × consumption) does not change, only what the two numbers mean.

alter table public.sd_standard_cost
  add column if not exists fabric_uom text not null default 'mtr';
alter table public.sd_standard_cost
  drop constraint if exists sd_standard_cost_fabric_uom_check;
alter table public.sd_standard_cost
  add constraint sd_standard_cost_fabric_uom_check check (fabric_uom in ('mtr', 'kg'));

alter table public.sd_standard_cost_extra_fabric
  add column if not exists uom text not null default 'mtr';
alter table public.sd_standard_cost_extra_fabric
  drop constraint if exists sd_standard_cost_extra_fabric_uom_check;
alter table public.sd_standard_cost_extra_fabric
  add constraint sd_standard_cost_extra_fabric_uom_check check (uom in ('mtr', 'kg'));
