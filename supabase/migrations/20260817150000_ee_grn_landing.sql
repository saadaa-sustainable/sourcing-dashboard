-- Inbound GRN line-items from EasyEcom GET /Grn/V2/getGrnDetails — the inbound-QC
-- disposition per received line (qc_pass/qc_fail/qc_pending/damaged/…). Vendor is
-- on the GRN header (exact — no SKU attribution). Populated by backfill/fetch-ee-grn.mjs.
-- Feeds the vendor REJECTION-rate factor (sd_vendor_grn_reject).
create table if not exists public.sd_ee_grn (
  grn_detail_id            bigint primary key,
  grn_id                   bigint,
  grn_created_at           date,
  grn_invoice_date         date,
  po_id                    bigint,
  po_number                text,
  po_ref_num               text,
  vendor_name              text,
  vendor_c_id              bigint,
  purchase_order_detail_id bigint,
  product_id               bigint,
  sku                      text,
  original_quantity        numeric,
  received_quantity        numeric,
  qc_pass                  numeric,
  qc_fail                  numeric,
  qc_pending               numeric,
  damaged                  numeric,
  return_to_source         numeric,
  discard                  numeric,
  lost                     numeric,
  synced_at                timestamptz not null default now()
);
create index if not exists sd_ee_grn_vendor_idx on public.sd_ee_grn (vendor_name);
create index if not exists sd_ee_grn_grn_idx on public.sd_ee_grn (grn_id);

alter table public.sd_ee_grn enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_ee_grn' and policyname='saadaa read sd_ee_grn') then
    create policy "saadaa read sd_ee_grn" on public.sd_ee_grn for select to authenticated using (public.sd_is_saadaa());
  end if;
end $$;
