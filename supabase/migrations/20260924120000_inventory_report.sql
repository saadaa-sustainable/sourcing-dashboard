-- Daily inventory report → Slack.
--
-- The whole inventory (sd_inventory_planning, one row per SKU × warehouse) is written to a
-- CSV each day, stored here, and a signed download link is posted to the Supply Chain
-- channel with a summary. Slack incoming webhooks are text-only — they cannot attach a
-- file — so the file lives in storage and the message carries a one-click link, which is
-- exactly how the buying-plan month report already works.
--
-- One row per day: re-running overwrites rather than piling up duplicates.

create table if not exists public.sd_inventory_report (
  id            bigint generated always as identity primary key,
  report_day    date not null unique,
  -- What the file was built from: the inventory snapshot's own data day, which can lag
  -- report_day if the sync has not run. Keeping both is what makes a stale report obvious.
  data_day      date,
  storage_path  text not null,
  rows          int  not null default 0,
  skus          int  not null default 0,
  summary       jsonb,
  generated_by  text,
  generated_at  timestamptz not null default now(),
  slack_posted_at timestamptz,
  slack_error   text
);

comment on table public.sd_inventory_report is
  'One row per day: the inventory CSV written to the inventory-reports bucket and posted to Slack.';

alter table public.sd_inventory_report enable row level security;
grant select, insert, update on public.sd_inventory_report to authenticated;

drop policy if exists "saadaa read sd_inventory_report" on public.sd_inventory_report;
create policy "saadaa read sd_inventory_report" on public.sd_inventory_report
  for select using (public.sd_is_saadaa());

drop policy if exists "sourcing write sd_inventory_report" on public.sd_inventory_report;
create policy "sourcing write sd_inventory_report" on public.sd_inventory_report
  for all using (public.sd_can_write()) with check (public.sd_can_write());

-- Private bucket: the link handed to Slack is a signed URL, not a public file.
insert into storage.buckets (id, name, public)
values ('inventory-reports', 'inventory-reports', false)
on conflict (id) do nothing;

drop policy if exists "saadaa read inventory-reports" on storage.objects;
create policy "saadaa read inventory-reports" on storage.objects
  for select using (bucket_id = 'inventory-reports' and public.sd_is_saadaa());
