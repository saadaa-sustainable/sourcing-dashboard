-- In-app feedback / issue channel. Users file a bug, suggestion or question with an
-- optional screenshot; the developer (Pushpendra) triages from an inbox and both
-- sides converse on the thread. Screenshots are stored as compressed base64 data
-- URLs on the message row (low volume; avoids a storage bucket + its RLS).
create table if not exists public.sd_feedback (
  id           bigint generated always as identity primary key,
  kind         text not null default 'bug' check (kind in ('bug', 'suggestion', 'question')),
  title        text not null,
  severity     text not null default 'medium' check (severity in ('low', 'medium', 'high', 'blocker')),
  status       text not null default 'new' check (status in ('new', 'acknowledged', 'in_progress', 'resolved', 'wont_fix')),
  page_path    text,                 -- where the reporter was when filing
  context      jsonb,                -- browser / OS / screen / viewport, auto-captured
  submitted_by text,
  submitted_at timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists sd_feedback_status_idx on public.sd_feedback (status, submitted_at desc);
create index if not exists sd_feedback_reporter_idx on public.sd_feedback (submitted_by, submitted_at desc);

-- Thread: the first message is the report body; later ones are the two-way
-- conversation. Each message may carry one screenshot.
create table if not exists public.sd_feedback_message (
  id           bigint generated always as identity primary key,
  feedback_id  bigint not null references public.sd_feedback(id) on delete cascade,
  author_email text,
  body         text,
  screenshot   text,                 -- compressed base64 data URL, or null
  created_at   timestamptz not null default now()
);

create index if not exists sd_feedback_message_thread_idx
  on public.sd_feedback_message (feedback_id, created_at);

alter table public.sd_feedback enable row level security;
alter table public.sd_feedback_message enable row level security;

-- Internal team tool: any signed-in SAADAA user can read the board and file/reply;
-- status changes are gated to admins in the server action.
drop policy if exists sd_feedback_read on public.sd_feedback;
create policy sd_feedback_read on public.sd_feedback for select using (public.sd_is_saadaa());
drop policy if exists sd_feedback_write on public.sd_feedback;
create policy sd_feedback_write on public.sd_feedback for all using (public.sd_can_write()) with check (public.sd_can_write());

drop policy if exists sd_feedback_msg_read on public.sd_feedback_message;
create policy sd_feedback_msg_read on public.sd_feedback_message for select using (public.sd_is_saadaa());
drop policy if exists sd_feedback_msg_write on public.sd_feedback_message;
create policy sd_feedback_msg_write on public.sd_feedback_message for insert with check (public.sd_can_write());
