-- A target cost per rate type. The team proposes a rate per PO type (Job / FOB / E-FOB; on the
-- material track FOB Fabric / Billing / Standard Fabric), but the approver's target was one
-- bare number, so nobody could tell which rate it was aimed at. Now the approver sets a target
-- for each type the proposal named. target_cost stays for the targets already set (shown as
-- "overall"); a new target clears it.
alter table public.sd_standard_cost
  add column if not exists target_job  numeric,
  add column if not exists target_fob  numeric,
  add column if not exists target_efob numeric;

alter table public.sd_material_standard_cost
  add column if not exists target_job  numeric,
  add column if not exists target_fob  numeric,
  add column if not exists target_efob numeric;

comment on column public.sd_standard_cost.target_cost is
  'Legacy single target (before 2026-10-06), type not recorded. New targets use target_job / target_fob / target_efob.';
