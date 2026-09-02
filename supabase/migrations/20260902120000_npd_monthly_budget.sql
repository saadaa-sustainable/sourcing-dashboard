-- =====================================================================
-- NPD monthly budget cap (spec §I item 2).
--
-- Sourcing/admin sets a FLAT monthly rupee cap for New Product Development;
-- NPD then CONSUMES it. The cap is an admin-filled figure (no hardcoded
-- default — an empty month means "not set yet", shown as such, never a fake
-- number). Consumption is computed live from approved NPD purchase orders
-- (sd_po_approval where category = 'npd'), so this table only stores the cap.
--
-- One row per plan month (first day of month, IST), matching the Buying Plan.
-- =====================================================================

create table public.sd_npd_budget (
  plan_month  date primary key,            -- first day of month (IST)
  cap_amount  numeric not null default 0,  -- flat monthly cap, ₹
  note        text,                        -- optional admin remark
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.sd_npd_budget enable row level security;

-- Everyone in SAADAA reads the cap (NPD sees its consumption read-only);
-- only admins (Sourcing leadership) set or change it.
create policy "saadaa read sd_npd_budget" on public.sd_npd_budget
  for select to authenticated using (public.sd_is_saadaa());
create policy "admin manage sd_npd_budget" on public.sd_npd_budget
  for all to authenticated
  using (public.sd_current_role() = 'admin')
  with check (public.sd_current_role() = 'admin');

grant select on public.sd_npd_budget to authenticated;
grant insert, update, delete on public.sd_npd_budget to authenticated;
