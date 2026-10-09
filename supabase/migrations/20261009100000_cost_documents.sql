-- Standard Cost document attachments (2026-10-09).
--
-- A Finished Goods standard cost carries its CAD plans (markers) and the RFP sheet link.
-- CAD plans sit in a library grouped under four primary headers:
--   single_piece    — Single piece
--   full_layer_58   — Full layer, single size, per width · 58" (each width separate)
--   full_layer_56   — Full layer, single size, per width · 56"
--   standard_ratio  — Standard ratio
--   ratio_1_1       — 1:1 size ratio
-- Each file is added with a remark and goes through two-level approval in the approval
-- workflow's words: L1 = the CAD checker (checks the CAD against the input), L2 = admin.
--   submitted   → Approval Pending · CAD check (L1)
--   pending_l2  → Approval Pending · admin (L2)
--   approved    → Edited & Approved (approver_edited) / First time Approved
--   rework      → Rework / Reassign (remark mandatory)
--   rejected    → Rejected / Discarded (remark mandatory)
-- The RFP sheet link is the cost's existing sd_standard_cost.rfp_link.

create table if not exists public.sd_cost_document (
  id bigserial primary key,
  product_code text not null,
  doc_group text not null check (doc_group in ('single_piece', 'full_layer_58', 'full_layer_56', 'standard_ratio', 'ratio_1_1')),
  file_path text not null,
  file_name text not null,
  file_size bigint,
  remark text,
  status text not null default 'submitted' check (status in ('submitted', 'pending_l2', 'approved', 'rework', 'rejected')),
  created_by text,
  submitted_at timestamptz not null default now(),
  l1_approved_by text,
  l1_approved_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  rework_notes text,
  reworked_by text,
  reworked_at timestamptz,
  rejection_notes text,
  edited_before_approval boolean not null default false,
  approver_edited boolean not null default false,
  updated_at timestamptz not null default now()
);
create index if not exists sd_cost_document_product_idx on public.sd_cost_document (product_code);
create index if not exists sd_cost_document_status_idx on public.sd_cost_document (status);

alter table public.sd_cost_document enable row level security;
drop policy if exists "saadaa read sd_cost_document" on public.sd_cost_document;
create policy "saadaa read sd_cost_document" on public.sd_cost_document
  for select to authenticated using ((select public.sd_is_saadaa()));
drop policy if exists "sourcing write sd_cost_document" on public.sd_cost_document;
create policy "sourcing write sd_cost_document" on public.sd_cost_document
  for all to authenticated using ((select public.sd_can_write())) with check ((select public.sd_can_write()));
grant select, insert, update, delete on public.sd_cost_document to authenticated;
grant usage on sequence public.sd_cost_document_id_seq to authenticated;

-- Who checks CAD at L1. Set by an admin on any Standard Cost product page. With nobody
-- set, any team member may do the L1 check (the usual first-stage rule).
create table if not exists public.sd_cad_checker (
  email text primary key,
  added_by text,
  added_at timestamptz not null default now()
);
alter table public.sd_cad_checker enable row level security;
drop policy if exists "saadaa read sd_cad_checker" on public.sd_cad_checker;
create policy "saadaa read sd_cad_checker" on public.sd_cad_checker
  for select to authenticated using ((select public.sd_is_saadaa()));
drop policy if exists "sourcing write sd_cad_checker" on public.sd_cad_checker;
create policy "sourcing write sd_cad_checker" on public.sd_cad_checker
  for all to authenticated using ((select public.sd_can_write())) with check ((select public.sd_can_write()));
grant select, insert, update, delete on public.sd_cad_checker to authenticated;

-- Private bucket; files reach it through server-issued signed upload URLs and are opened
-- through short-lived signed URLs, so no storage.objects policies are needed.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cost-documents', 'cost-documents', false, 26214400, null)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- Audit trail, same as every other table typed on the dashboard (no-op if absent).
do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_cost_document;
    create trigger sd_audit after insert or update or delete on public.sd_cost_document
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;

-- One row per uploaded file (a double-click must not add it twice).
create unique index if not exists sd_cost_document_file_uidx on public.sd_cost_document (file_path);
