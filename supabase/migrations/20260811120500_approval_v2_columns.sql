-- Shared approval workflow v2: edited-tracking + rework notes on every approvable
-- entity, line-item rework fields, receivable-plan approval, and PO line items.

-- edited_before_approval drives the "First-Time-Approved" vs "Edited-and-Approved"
-- split; rework_notes/reworked_* record a Rework/Reassign decision.
do $$
declare t text;
begin
  foreach t in array array['sd_buying_plan','sd_po_approval','sd_standard_cost','sd_discontinue_request']
  loop
    execute format('alter table public.%1$I add column if not exists edited_before_approval boolean not null default false', t);
    execute format('alter table public.%1$I add column if not exists rework_notes text', t);
    execute format('alter table public.%1$I add column if not exists reworked_by text', t);
    execute format('alter table public.%1$I add column if not exists reworked_at timestamptz', t);
  end loop;
end $$;

-- Buying-plan line-item rework.
alter table public.sd_buying_plan_line add column if not exists line_status public.sd_status;
alter table public.sd_buying_plan_line add column if not exists rework_notes text;

-- Receivable plan brought into the approval workflow.
alter table public.sd_receivable_input add column if not exists status public.sd_status not null default 'draft';
alter table public.sd_receivable_input add column if not exists submitted_by text;
alter table public.sd_receivable_input add column if not exists submitted_at timestamptz;
alter table public.sd_receivable_input add column if not exists approved_by text;
alter table public.sd_receivable_input add column if not exists approved_at timestamptz;
alter table public.sd_receivable_input add column if not exists rejection_notes text;
alter table public.sd_receivable_input add column if not exists rework_notes text;
alter table public.sd_receivable_input add column if not exists edited_before_approval boolean not null default false;

-- PO approval line items (colour/size) for line-item rework.
create table if not exists public.sd_po_approval_line (
  id              bigserial primary key,
  po_id           bigint not null references public.sd_po_approval(id) on delete cascade,
  product_variant text,
  size            text,
  qty             numeric not null default 0,
  line_status     public.sd_status,
  rework_notes    text,
  created_at      timestamptz not null default now()
);
create index if not exists sd_po_approval_line_po_idx on public.sd_po_approval_line (po_id);
alter table public.sd_po_approval_line enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_po_approval_line' and policyname='saadaa read sd_po_approval_line') then
    create policy "saadaa read sd_po_approval_line" on public.sd_po_approval_line for select to authenticated using (public.sd_is_saadaa());
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_po_approval_line' and policyname='sourcing write sd_po_approval_line') then
    create policy "sourcing write sd_po_approval_line" on public.sd_po_approval_line for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write());
  end if;
end $$;
