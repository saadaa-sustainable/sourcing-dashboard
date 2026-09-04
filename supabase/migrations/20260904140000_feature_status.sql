-- Item 1 (sprint-phase labeling). A small editable status per feature so the team can
-- mark what's visible-but-not-final. Pairs with the existing "hide non-released from
-- non-admins" rule: fully hidden for things not ready to be seen at all, LABELLED for
-- things visible but not yet fully trustworthy. Rules-Master-style — status changes
-- without a code change. feature_key = the views.ts path (e.g. '/cost-analytics',
-- 'tab:matrix'). No row = no badge (assumed live/normal).
create table if not exists public.sd_feature_status (
  feature_key text primary key,          -- matches a lib/views.ts path
  status      text not null default 'live' check (status in ('live', 'testing', 'soon')),
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.sd_feature_status enable row level security;

drop policy if exists sd_feature_status_read on public.sd_feature_status;
create policy sd_feature_status_read on public.sd_feature_status
  for select using (public.sd_is_saadaa());

drop policy if exists sd_feature_status_write on public.sd_feature_status;
create policy sd_feature_status_write on public.sd_feature_status
  for all using (public.sd_can_write()) with check (public.sd_can_write());
