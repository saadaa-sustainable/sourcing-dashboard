-- Correction (Mahesh): the EFOB fabric rate was NEVER a single generalised rate for
-- all fabrics together — it is set per INDIVIDUAL fabric, monthly. The original
-- sd_efob_fabric_cost keyed on month alone (one company-wide rate/month) was wrong.
-- Reshape to per-fabric per-month: primary key (fabric_code, month). The table is
-- empty (no rate ever entered), so this is a clean reshape with no data to migrate.
alter table public.sd_efob_fabric_cost add column if not exists fabric_code text;

-- Swap the month-only PK for a composite (fabric_code, month) PK. Safe on an empty
-- table; fabric_code becomes mandatory (it's part of the key).
alter table public.sd_efob_fabric_cost drop constraint if exists sd_efob_fabric_cost_pkey;
update public.sd_efob_fabric_cost set fabric_code = coalesce(fabric_code, '') where fabric_code is null;
alter table public.sd_efob_fabric_cost alter column fabric_code set not null;
alter table public.sd_efob_fabric_cost add constraint sd_efob_fabric_cost_pkey primary key (fabric_code, month);
