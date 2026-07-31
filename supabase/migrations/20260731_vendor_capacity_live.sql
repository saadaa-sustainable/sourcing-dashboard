-- Vendor Capacity: one live row per vendor, date-stamped (drop week-of bucketing).
-- Collapse any existing multi-week history to the most-recent row per vendor, then
-- switch the unique key from (vendor_code, week_of) to (vendor_code). Each save now
-- overwrites that vendor's single current record and stamps entry_date, so staleness
-- is simply the age of the row.

-- 1. Keep only the latest week_of (tie-break newest id) per vendor.
delete from public.sd_vendor_capacity_log a
using public.sd_vendor_capacity_log b
where a.vendor_code = b.vendor_code
  and (a.week_of < b.week_of
       or (a.week_of = b.week_of and a.id < b.id));

-- 2. entry_date = when the row was actually entered (back-fill from submitted_at).
alter table public.sd_vendor_capacity_log
  add column if not exists entry_date timestamptz not null default now();
update public.sd_vendor_capacity_log set entry_date = submitted_at;

-- 3. Swap the unique key: one current row per vendor. week_of is now legacy/nullable.
alter table public.sd_vendor_capacity_log
  drop constraint if exists sd_vendor_capacity_log_vendor_code_week_of_key;
alter table public.sd_vendor_capacity_log
  alter column week_of drop not null;
create unique index if not exists sd_vendor_capacity_vendor_key
  on public.sd_vendor_capacity_log (vendor_code);
