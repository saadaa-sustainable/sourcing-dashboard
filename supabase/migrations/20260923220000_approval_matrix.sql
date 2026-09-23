-- Spec 7.5 — the approval hierarchy as an escalation matrix: L1 → L2 → L3 (Mahesh),
-- with two or three named people at L1 and L2 so nobody's absence stops a PO.
--
-- The ladder itself is unchanged: an item routed to the team waits at 'submitted' (L1),
-- one routed to admin waits at 'pending_l2' (L2). What this adds is WHO, by name, sits at
-- each level, and what happens when they sit on it: past the escalation window the level
-- above can also decide. L3 is the final authority and can always decide.
--
-- With no rows in this table the behaviour is exactly what it was — the role ladder — so
-- the matrix can be filled in at leisure.

create table if not exists public.sd_approval_matrix (
  id         bigint generated always as identity primary key,
  level      text not null check (level in ('l1', 'l2', 'l3')),
  email      text not null,
  -- 1 = the person the work normally goes to, 2 and 3 = the fallbacks/swaps.
  position   int  not null default 1,
  active     boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now(),
  unique (level, email)
);

comment on table public.sd_approval_matrix is
  'Spec 7.5 escalation matrix: who approves at L1 / L2 / L3. Empty = fall back to the role ladder.';

create index if not exists sd_approval_matrix_level_idx on public.sd_approval_matrix (level, position);

alter table public.sd_approval_matrix enable row level security;

drop policy if exists "saadaa read sd_approval_matrix" on public.sd_approval_matrix;
create policy "saadaa read sd_approval_matrix"
  on public.sd_approval_matrix for select using (sd_is_saadaa());

drop policy if exists "sourcing write sd_approval_matrix" on public.sd_approval_matrix;
create policy "sourcing write sd_approval_matrix"
  on public.sd_approval_matrix for all using (sd_can_write()) with check (sd_can_write());

-- How long an item may sit at its level before the level above can also act on it.
insert into public.sd_analytics_rule (rule_key, value, label, description)
values (
  'approval_escalation_days', 2,
  'Approval escalation (days)',
  'Days an item may wait at its approval level before it escalates — the level above can then decide it too. The people at each level are set in User Panel → Approval matrix.'
)
on conflict (rule_key) do nothing;
