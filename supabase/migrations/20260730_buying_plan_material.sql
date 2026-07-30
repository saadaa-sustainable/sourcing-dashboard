-- Buying Plan: parallel Fabric / Material track alongside Finished Goods.
-- Same table, same Save → Submit → Approve flow; a plan_type discriminator
-- lets one month hold an independent FG plan and material plan.

-- 1. plan_type discriminator on the header (default 'fg' keeps existing rows FG).
alter table sd_buying_plan
  add column if not exists plan_type text not null default 'fg';

-- Uniqueness is now per (month, type) instead of per month, so an FG plan and a
-- material plan can coexist for the same plan_month.
alter table sd_buying_plan
  drop constraint if exists sd_buying_plan_plan_month_key;
drop index if exists sd_buying_plan_month_type_key;
create unique index sd_buying_plan_month_type_key
  on sd_buying_plan (plan_month, plan_type);

-- 2. Unit of measure on the line (metres / kg / pcs …), only meaningful for
-- material lines; null for FG.
alter table sd_buying_plan_line
  add column if not exists uom text;

-- 3. Distinct raw-material codes for the material line datalist, sourced from the
-- inventory planning snapshot.
create or replace view sd_material_codes as
select distinct
  upper(btrim(rm_code)) as material_code,
  max(fabric_name)      as fabric_name
from sd_inventory_planning
where rm_code is not null and btrim(rm_code) <> ''
group by upper(btrim(rm_code));
