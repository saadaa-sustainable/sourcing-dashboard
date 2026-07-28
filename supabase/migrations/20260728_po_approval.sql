-- =====================================================================
-- PO Approval — a new approval entity on the existing engine
-- (sd_approval_log, decideApproval, routeApproval).
--
-- Field list is the sheet-verified spec (PO_raw_data · SCHEMA · row 23):
-- 18 inputs + the DiGiO-signed issuance fields. Routing is by CATEGORY:
--   NPD → 2-level (admin) always · FG → ≤5000 L1(team) / >5000 L2(admin)
--   · MAT → 2-level (admin).
--
--   po_type  = FOB | job_work | efob      (how the PO is placed)
--   category = fg  | mat | npd             (drives approval routing)
--
-- DiGiO document signing (signed_* + date_of_po_sign) and auto PO-number
-- generation are phase-2 — columns exist, populated later.
-- =====================================================================

drop view if exists public.sd_po_cycle_time;
drop table if exists public.sd_po_approval;

create table public.sd_po_approval (
  id                          bigserial primary key,
  timestamp_created           timestamptz not null default now(),
  created_by                  text,
  -- inputs (all marked Y in the schema sheet)
  po_type                     text,          -- FOB | job_work | efob
  product_code                text,
  po_ref_num                  text,
  vendor_code                 text,
  vendor_name                 text,
  tna_sheet_url               text,          -- Google Drive link
  cost_sheet_url              text,
  po_qty                      numeric not null default 0,
  po_closing_date             date,          -- as per TNA
  cad_folder_url              text,          -- conditional: EFOB POs only
  cs_pp_sample_due            date,          -- critical stage: PP sample approval
  cs_gpt_due                  date,          -- critical stage: GPT approval
  cs_cutting_start            date,          -- critical stage: cutting start
  cs_inline_qc_due            date,          -- critical stage: inline QC approval
  critical_path_first_delivery date,
  trim_card_signed            boolean not null default false,
  buying_plan_no              text,          -- links back to the buying plan
  category                    text not null default 'fg', -- fg | mat | npd (routing)
  -- approval workflow
  status                      public.sd_status not null default 'draft',
  submitted_for_approval_at   timestamptz,   -- cycle-time start
  approved_by                 text,
  approved_at                 timestamptz,   -- cycle-time mid
  rejection_notes             text,
  -- issuance / DiGiO signing (phase 2 for the signed_* set)
  easycom_po_no               text,          -- EE — mapping key to sd_po_master_raw
  signed_po_document_url      text,          -- DiGiO
  signed_cost_sheet_url       text,          -- DiGiO
  signed_tna_url              text,          -- DiGiO
  signed_po_ref_number        text,          -- DiGiO
  date_of_po_sign             date,          -- DiGiO
  first_actual_delivery_date  date,          -- EE
  po_issued_at                timestamptz,   -- cycle-time end
  created_at                  timestamptz not null default now()
);
create index sd_po_approval_status_idx  on public.sd_po_approval (status);
create index sd_po_approval_vendor_idx  on public.sd_po_approval (vendor_code);
create index sd_po_approval_easycom_idx on public.sd_po_approval (easycom_po_no);
create index sd_po_approval_issued_idx  on public.sd_po_approval (po_issued_at);

-- Cycle-time view for analytics. Unfiltered so in-flight POs still surface
-- days_to_approve; total_cycle_days is null until the PO is issued.
create view public.sd_po_cycle_time as
select
  id, po_ref_num, vendor_code, category,
  submitted_for_approval_at, approved_at, po_issued_at,
  round((extract(epoch from (approved_at  - submitted_for_approval_at)) / 86400)::numeric, 1) as days_to_approve,
  round((extract(epoch from (po_issued_at - approved_at))               / 86400)::numeric, 1) as days_to_issue,
  round((extract(epoch from (po_issued_at - submitted_for_approval_at)) / 86400)::numeric, 1) as total_cycle_days
from public.sd_po_approval;

-- RLS: read for any @saadaa.in; write for team/admin (sd_can_write).
alter table public.sd_po_approval enable row level security;
grant select, insert, update, delete on public.sd_po_approval to authenticated;
grant usage, select on sequence public.sd_po_approval_id_seq to authenticated;
create policy "saadaa read sd_po_approval" on public.sd_po_approval
  for select to authenticated using (public.sd_is_saadaa());
create policy "sourcing write sd_po_approval" on public.sd_po_approval
  for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write());
grant select on public.sd_po_cycle_time to authenticated;
