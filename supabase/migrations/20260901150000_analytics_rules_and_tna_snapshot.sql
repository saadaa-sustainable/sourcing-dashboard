-- =====================================================================
-- Main-dashboard analytics foundation (cross-tab decision cards).
--
-- 1. sd_analytics_rule — the editable Rules Master for card thresholds.
--    Every judgement number the analytics cards use (utilization bands,
--    vendor-concentration alert %, capital-risk quantile, reliability
--    window, ...) lives here, NOT hardcoded in component code. Seeded with
--    defaults; admin edits via the dashboard (upsert), everyone reads.
--
-- 2. sd_tna_status_snapshot — daily counts of on-time / high-risk / overdue
--    open POs, for the TNA Compliance Trend card. The live schema only holds
--    current state; the trend needs history. Recorded idempotently (once per
--    IST day) by sd_record_tna_snapshot(), called best-effort on dashboard
--    load — the counts come from the same buildTrackerRows/isTnaHighRisk
--    logic the Open PO Tracker shows, so the snapshot always matches what
--    users saw that day.
-- =====================================================================

create table public.sd_analytics_rule (
  rule_key    text primary key,
  value       numeric not null,
  label       text not null,
  description text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.sd_analytics_rule enable row level security;
create policy "saadaa read sd_analytics_rule" on public.sd_analytics_rule
  for select to authenticated using (public.sd_is_saadaa());
create policy "admin manage sd_analytics_rule" on public.sd_analytics_rule
  for all to authenticated
  using (public.sd_current_role() = 'admin')
  with check (public.sd_current_role() = 'admin');
grant select on public.sd_analytics_rule to authenticated;
grant insert, update, delete on public.sd_analytics_rule to authenticated;

insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('capital_risk_quantile',      0.75, 'Capital at Risk — value quantile',
   'A high-risk PO counts as Capital at Risk when its pending value is in the top (1−q) of open POs. 0.75 = top quartile.'),
  ('vendor_concentration_alert', 40,   'Vendor concentration alert %',
   'Flag when the top-3 vendors hold more than this % of total open buying value.'),
  ('utilization_under_pct',      70,   'Utilization — under-utilized below %',
   'Vendors below this utilization have spare capacity (could absorb more POs).'),
  ('utilization_over_pct',       100,  'Utilization — over-committed above %',
   'Vendors above this utilization are over-committed.'),
  ('reliability_window_days',    60,   'Vendor reliability window (days)',
   'Rolling window for the recent delivery-reliability ranking.'),
  ('closure_sla_days',           15,   'PO closure SLA (days)',
   'Completed POs must close within this many days (compliance card).')
on conflict (rule_key) do nothing;

-- ---------------------------------------------------------------------

create table public.sd_tna_status_snapshot (
  snapshot_date date primary key,
  on_time    integer not null default 0,
  high_risk  integer not null default 0,
  overdue    integer not null default 0,
  open_total integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.sd_tna_status_snapshot enable row level security;
create policy "saadaa read sd_tna_status_snapshot" on public.sd_tna_status_snapshot
  for select to authenticated using (public.sd_is_saadaa());
grant select on public.sd_tna_status_snapshot to authenticated;

-- Idempotent daily recorder: first dashboard load of the (IST) day writes the
-- row; later loads are no-ops so the day keeps its first-seen state. SECURITY
-- DEFINER so viewers' page loads can record without a write policy.
create or replace function public.sd_record_tna_snapshot(
  p_on_time integer, p_high_risk integer, p_overdue integer, p_open_total integer
) returns void
language sql security definer set search_path = ''
as $$
  insert into public.sd_tna_status_snapshot (snapshot_date, on_time, high_risk, overdue, open_total)
  values ((now() at time zone 'Asia/Kolkata')::date, p_on_time, p_high_risk, p_overdue, p_open_total)
  on conflict (snapshot_date) do nothing;
$$;

revoke all on function public.sd_record_tna_snapshot(integer, integer, integer, integer) from public;
grant execute on function public.sd_record_tna_snapshot(integer, integer, integer, integer) to authenticated;
