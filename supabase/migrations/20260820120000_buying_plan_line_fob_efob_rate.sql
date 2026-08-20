-- Per-unit buying rates as shown on the buying-plan sheet (FOB/EFOB rate and JOB rate),
-- so the dashboard can show the plan in full sheet detail. job_rate already exists
-- (material track) and is reused for the FG JOB rate.
alter table public.sd_buying_plan_line add column if not exists fob_efob_rate numeric;
