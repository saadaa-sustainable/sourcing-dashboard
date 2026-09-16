-- Buying Plan month-end lifecycle (spec item 5):
--   * month-end FREEZE is a pure date rule (month M is frozen from the 1st of M+1) — no
--     stored flag; but a post-freeze/post-approval AMENDMENT (the "maroon fabric" case:
--     team realises a product was missed) is tracked so the first-time-approval metric
--     can tell a clean approval from an amended one;
--   * the analytical month report (PDF) generated on the 1st, stored in a private bucket
--     and posted to the Supply Chain Slack channel — one row per month for idempotency;
--   * the approval deadline (7th of the plan month) lives in the Rules Master.

-- 1. Amendment tracking on the plan.
alter table public.sd_buying_plan
  add column if not exists amended_after_freeze   boolean not null default false,
  add column if not exists amendment_requested_by text,
  add column if not exists amendment_requested_at timestamptz;

-- 2. Month report registry (one per plan month + type; regenerating overwrites).
create table if not exists public.sd_plan_report (
  id               bigserial primary key,
  plan_month       date not null,
  plan_type        text not null default 'fg',
  generated_at     timestamptz not null default now(),
  generated_by     text,                      -- email, or 'cron'
  storage_path     text not null,             -- plan-reports/<path>
  file_bytes       integer,
  summary          jsonb,                     -- headline figures for the Slack post / UI
  slack_posted_at  timestamptz,
  slack_error      text,
  unique (plan_month, plan_type)
);
alter table public.sd_plan_report enable row level security;
grant select, insert, update on public.sd_plan_report to authenticated;
grant usage, select on sequence public.sd_plan_report_id_seq to authenticated;
drop policy if exists "saadaa read sd_plan_report" on public.sd_plan_report;
create policy "saadaa read sd_plan_report" on public.sd_plan_report
  for select using (sd_is_saadaa());
drop policy if exists "sourcing write sd_plan_report" on public.sd_plan_report;
create policy "sourcing write sd_plan_report" on public.sd_plan_report
  for all using (sd_can_write()) with check (sd_can_write());

-- 3. Private bucket for the generated PDFs (uploaded by the service role; read by
--    saadaa users through short-lived signed URLs, exactly like cutting-approvals).
insert into storage.buckets (id, name, public)
values ('plan-reports', 'plan-reports', false)
on conflict (id) do nothing;
drop policy if exists "plan_reports_read" on storage.objects;
create policy "plan_reports_read" on storage.objects
  for select to authenticated
  using (bucket_id = 'plan-reports' and public.sd_is_saadaa());

-- 4. Approval deadline: day of the plan month by which the plan must be approved.
--    After it, a still-unapproved plan is a compliance breach (submission-side if it
--    was not even submitted by then, approval-side if it was).
insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('plan_approval_deadline_day', 7, 'Buying plan approval deadline (day of month)',
   'The plan for a month must be approved by this day of that month (e.g. 7 = 7th Oct for the October plan). Later = compliance breach, attributed to the submission side if the plan was not submitted by then, else to the approval side.')
on conflict (rule_key) do nothing;
