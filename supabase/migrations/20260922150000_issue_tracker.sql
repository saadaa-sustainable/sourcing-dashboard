-- Issue / ticket tracker (spec part 3).
--
-- Anyone raises an issue to anyone ("this PO is coming wrong"); the dashboard also raises
-- its own from the checks it already runs (an open PO with no TNA timeline, a line with
-- no delivery date, a discontinued product still on order, a stale feed) so the reason a
-- number is wrong is on a named person's list, not just red on a card. Assignment routes
-- by category (sd_issue_route). Days from raise to resolve are read off the timestamps.
--
-- Separate from sd_feedback on purpose: that is the developer's inbox for the dashboard
-- itself; this is the team's work about the business.

create table public.sd_issue (
  id            bigint generated always as identity primary key,
  category      text not null check (category in
                  ('po', 'tna', 'vendor', 'product', 'inventory', 'plan', 'cost', 'data', 'other')),
  title         text not null,
  detail        text,
  related_ref   text,                       -- PO ref / product code / vendor code it is about
  page_path     text,                       -- where the raiser was
  source        text not null default 'manual' check (source in ('manual', 'auto')),
  auto_key      text,                       -- idempotency key for auto-raised issues
  severity      text not null default 'medium' check (severity in ('low', 'medium', 'high', 'blocker')),
  status        text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'dismissed')),
  raised_by     text,                       -- email; 'system' for auto
  raised_at     timestamptz not null default now(),
  assignee      text,                       -- email
  assigned_via  text check (assigned_via in ('manual', 'route')),
  assigned_at   timestamptz,
  resolved_at   timestamptz,
  resolved_by   text,
  resolution    text,
  updated_at    timestamptz not null default now()
);

-- One LIVE auto issue per detection key; once resolved the key may be raised again.
create unique index sd_issue_auto_live_unique
  on public.sd_issue (auto_key)
  where source = 'auto' and status in ('open', 'in_progress');
create index sd_issue_status_idx on public.sd_issue (status, raised_at desc);
create index sd_issue_assignee_idx on public.sd_issue (assignee, status);

create table public.sd_issue_message (
  id            bigint generated always as identity primary key,
  issue_id      bigint not null references public.sd_issue(id) on delete cascade,
  author_email  text,
  body          text not null,
  created_at    timestamptz not null default now()
);
create index sd_issue_message_thread_idx on public.sd_issue_message (issue_id, created_at);

-- Category → who picks it up. One row per category, editable by an admin on the tracker.
create table public.sd_issue_route (
  category      text primary key,
  label         text not null,
  assignee      text,                       -- email; null = unrouted (stays unassigned)
  updated_by    text,
  updated_at    timestamptz not null default now()
);
insert into public.sd_issue_route (category, label) values
  ('po',        'Purchase orders'),
  ('tna',       'TNA / production timeline'),
  ('vendor',    'Vendors'),
  ('product',   'Products / master data'),
  ('inventory', 'Stock / out of stock'),
  ('plan',      'Buying plan'),
  ('cost',      'Standard cost / rates'),
  ('data',      'Data feeds / sync'),
  ('other',     'Other')
on conflict (category) do nothing;

alter table public.sd_issue         enable row level security;
alter table public.sd_issue_message enable row level security;
alter table public.sd_issue_route   enable row level security;

create policy "saadaa read sd_issue" on public.sd_issue for select using (public.sd_is_saadaa());
create policy "sourcing write sd_issue" on public.sd_issue for all
  using (public.sd_can_write()) with check (public.sd_can_write());
create policy "saadaa read sd_issue_message" on public.sd_issue_message for select using (public.sd_is_saadaa());
create policy "sourcing write sd_issue_message" on public.sd_issue_message for insert with check (public.sd_can_write());
create policy "saadaa read sd_issue_route" on public.sd_issue_route for select using (public.sd_is_saadaa());
create policy "sourcing write sd_issue_route" on public.sd_issue_route for all
  using (public.sd_can_write()) with check (public.sd_can_write());
