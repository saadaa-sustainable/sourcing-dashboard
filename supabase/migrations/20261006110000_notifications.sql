-- In-app notifications for the bell. A notice goes to one person (recipient_email) or to everyone
-- with a role (audience_role, e.g. the team when the approver sets a target). Read state is per
-- person, so one notice to the team is marked read by each member separately.
create table if not exists public.sd_notification (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  kind            text not null,
  title           text not null,
  body            text,
  link            text,
  audience_role   public.sd_role,
  recipient_email text,
  created_by      text,
  constraint sd_notification_has_audience check (audience_role is not null or recipient_email is not null)
);
create index if not exists sd_notification_recipient_idx on public.sd_notification (lower(recipient_email), created_at desc);
create index if not exists sd_notification_role_idx on public.sd_notification (audience_role, created_at desc);

create table if not exists public.sd_notification_read (
  notification_id bigint not null references public.sd_notification(id) on delete cascade,
  user_email      text not null,
  read_at         timestamptz not null default now(),
  primary key (notification_id, user_email)
);

alter table public.sd_notification enable row level security;
alter table public.sd_notification_read enable row level security;

-- Read: notices addressed to me, or to my role.
drop policy if exists sd_notification_read_mine on public.sd_notification;
create policy sd_notification_read_mine on public.sd_notification for select to authenticated
  using (
    (select public.sd_is_saadaa())
    and (
      lower(recipient_email) = lower(coalesce((select auth.jwt()) ->> 'email', ''))
      or audience_role = (select public.sd_current_role())
    )
  );
-- Write: anyone who can act in the app raises notices as a side effect of their action.
drop policy if exists sd_notification_insert on public.sd_notification;
create policy sd_notification_insert on public.sd_notification for insert to authenticated
  with check ((select public.sd_can_write()));

-- Read state: each person sees and writes only their own.
drop policy if exists sd_notification_read_own on public.sd_notification_read;
create policy sd_notification_read_own on public.sd_notification_read for all to authenticated
  using (lower(user_email) = lower(coalesce((select auth.jwt()) ->> 'email', '')))
  with check (lower(user_email) = lower(coalesce((select auth.jwt()) ->> 'email', '')));

revoke all on public.sd_notification, public.sd_notification_read from anon;
grant select, insert on public.sd_notification to authenticated;
grant select, insert, update, delete on public.sd_notification_read to authenticated;
grant usage on sequence public.sd_notification_id_seq to authenticated;

-- Notices are kept 90 days, like the logs.
create or replace function public.sd_prune_logs(keep_days int default 90)
returns table (table_name text, rows_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => keep_days);
  n bigint;
begin
  delete from public.sd_inventory_webhook_log where received_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sd_inventory_webhook_log'; rows_deleted := n; return next;

  delete from public.sd_grn_webhook_log where received_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sd_grn_webhook_log'; rows_deleted := n; return next;

  delete from public.sync_log where started_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sync_log'; rows_deleted := n; return next;

  delete from public.sd_notification where created_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sd_notification'; rows_deleted := n; return next;
end;
$$;
revoke all on function public.sd_prune_logs(int) from public, anon, authenticated;
