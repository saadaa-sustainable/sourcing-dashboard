-- Feedback v2: upvotes, record links, tags, assignee, and a resolution note that
-- powers the "you asked, we shipped" changelog.
alter table public.sd_feedback add column if not exists related_ref text;   -- a PO/product/vendor code the report is about
alter table public.sd_feedback add column if not exists tags        text[]; -- free labels for triage
alter table public.sd_feedback add column if not exists assignee     text;  -- who's on it (dev email)
alter table public.sd_feedback add column if not exists resolution   text;  -- shown in the changelog when resolved

-- "Me too" votes — one per user per report; drives prioritisation + dedupe.
create table if not exists public.sd_feedback_vote (
  feedback_id  bigint not null references public.sd_feedback(id) on delete cascade,
  voter_email  text not null,
  created_at   timestamptz not null default now(),
  primary key (feedback_id, voter_email)
);
create index if not exists sd_feedback_vote_fb_idx on public.sd_feedback_vote (feedback_id);

alter table public.sd_feedback_vote enable row level security;
drop policy if exists sd_feedback_vote_read on public.sd_feedback_vote;
create policy sd_feedback_vote_read on public.sd_feedback_vote for select using (public.sd_is_saadaa());
drop policy if exists sd_feedback_vote_write on public.sd_feedback_vote;
create policy sd_feedback_vote_write on public.sd_feedback_vote for all using (public.sd_can_write()) with check (public.sd_can_write());
