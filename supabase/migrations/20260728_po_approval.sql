-- =====================================================================
-- PO Approval — a new approval entity on the existing engine
-- (sd_approval_log, decideApproval, routeApproval). Sourcing raises a PO
-- for approval; on approval it is issued with an EasyCom PO number that ties
-- back to sd_po_master_raw. Phase-2 items (DGO signing, auto PO-number
-- generation) are stubbed columns for now.
-- =====================================================================

create table if not exists public.sd_po_approval (
  id                        bigserial primary key,
  po_ref                    text,                         -- manual until auto-gen (phase 2)
  po_type                   text not null default 'FG',   -- FG | Material | NPD
  product_code              text,
  vendor_code               text,
  quantity                  numeric not null default 0,
  number_of_colours         integer,                      -- computed from variant count at submit
  cost_sheet_link           text,
  tna_link                  text,
  -- TNA critical dates (the four production milestones)
  tna_pp_date               date,
  tna_gpt_date              date,
  tna_cutting_date          date,
  tna_inline_date           date,
  closing_date              date,

  status                    public.sd_status not null default 'draft',
  submitted_by              text,
  submitted_for_approval_at timestamptz,
  approved_by               text,
  approved_at               timestamptz,
  rejection_notes           text,

  -- issuance: entered at PO issue time; easycom_po_number maps to
  -- sd_po_master_raw.po_number so the issued PO can be traced to real data.
  easycom_po_number         text,
  po_issued_by              text,
  po_issued_at              timestamptz,

  -- phase 2 stubs
  dgo_signed                boolean not null default false,
  dgo_signed_by             text,
  dgo_signed_at             timestamptz,
  auto_po_number            text,

  created_at                timestamptz not null default now()
);
create index if not exists sd_po_approval_status_idx on public.sd_po_approval (status);
create index if not exists sd_po_approval_vendor_idx on public.sd_po_approval (vendor_code);
create index if not exists sd_po_approval_easycom_idx on public.sd_po_approval (easycom_po_number);

-- Cycle-time view: how long each stage of the PO lifecycle took (in days).
create or replace view public.sd_po_cycle_time as
select
  id, po_ref, po_type, product_code, vendor_code, status,
  submitted_for_approval_at, approved_at, po_issued_at,
  round((extract(epoch from (approved_at  - submitted_for_approval_at)) / 86400)::numeric, 1) as days_submit_to_approve,
  round((extract(epoch from (po_issued_at - approved_at))               / 86400)::numeric, 1) as days_approve_to_issue,
  round((extract(epoch from (po_issued_at - submitted_for_approval_at)) / 86400)::numeric, 1) as days_total
from public.sd_po_approval;

-- RLS: read for any @saadaa.in; write for team/admin (sd_can_write).
alter table public.sd_po_approval enable row level security;
grant select, insert, update, delete on public.sd_po_approval to authenticated;
grant usage, select on sequence public.sd_po_approval_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_po_approval' and policyname='saadaa read sd_po_approval') then
    execute 'create policy "saadaa read sd_po_approval" on public.sd_po_approval
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_po_approval' and policyname='sourcing write sd_po_approval') then
    execute 'create policy "sourcing write sd_po_approval" on public.sd_po_approval
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
grant select on public.sd_po_cycle_time to authenticated;
