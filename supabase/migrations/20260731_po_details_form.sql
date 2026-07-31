-- Google Form "PO Details Form" (Production Dashboard spreadsheet) -> Supabase mirror.
-- GCP/EasyEcom remain the source of truth for the PO's transactional data; this form
-- carries the sourcing/issuance METADATA the team fills at issue time (signed docs, TNA
-- plan links, critical-stage dates, buying-plan no.), keyed to the live PO by its ref.
create table if not exists public.po_details_form (
  source_row_key           text primary key,
  submitted_at             timestamptz,
  email_address            text,
  po_type                  text,
  product_code             text,
  po_number                text,   -- the FY../ ref (= po_ref_num in GCP)
  easyecom_po_no           text,   -- EasyEcom PO no as captured on the form
  date_of_po_sign          date,
  vendor_name              text,
  signed_po_document       text,
  signed_po_cost_sheet     text,
  signed_tna               text,
  tna_sheet_link           text,
  no_of_colors             integer,
  po_qty                   numeric,
  po_closing_date          date,
  vendor_master_sheet_link text,
  trim_card_signed         boolean,
  pp_sample_due            date,
  gpt_due                  date,
  cutting_date             date,
  inline_qc_date           date,
  cad_folder_link          text,
  buying_plan_no           text,
  is_active                boolean not null default true,
  sync_token               text,
  synced_at                timestamptz
);
create index if not exists po_details_form_easyecom_idx on public.po_details_form (easyecom_po_no);

alter table public.po_details_form enable row level security;
grant select on public.po_details_form to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='po_details_form' and policyname='saadaa read po_details_form') then
    execute 'create policy "saadaa read po_details_form" on public.po_details_form
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
end $$;

-- Display view: the form's sourcing metadata + a flag for whether the PO is still in the
-- live GCP/EasyEcom open pipeline. Match on the PO ref (form.po_number = GCP po_ref_num),
-- not the EasyEcom numeric id (a different internal id in the dashboard view).
create or replace view public.sd_po_details as
select
  f.source_row_key, f.submitted_at, f.email_address as merchandiser,
  f.po_type, f.product_code, f.po_number, f.easyecom_po_no, f.vendor_name,
  f.date_of_po_sign, f.no_of_colors, f.po_qty, f.po_closing_date,
  f.trim_card_signed, f.buying_plan_no,
  f.pp_sample_due, f.gpt_due, f.cutting_date, f.inline_qc_date,
  f.signed_po_document, f.signed_po_cost_sheet, f.signed_tna,
  f.tna_sheet_link, f.cad_folder_link, f.vendor_master_sheet_link,
  (g.po_ref_num is not null) as matched_to_live_po
from public.po_details_form f
left join (select distinct po_ref_num from public.sd_po_dashboard where po_ref_num is not null) g
  on upper(trim(g.po_ref_num)) = upper(trim(f.po_number))
where f.is_active;

grant select on public.sd_po_details to authenticated;
