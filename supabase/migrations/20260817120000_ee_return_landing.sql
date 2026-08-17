-- Customer returns + exchanges pulled from EasyEcom GET /orders/getAllReturns,
-- one row per returned line-item. Populated by backfill/fetch-ee-returns.mjs.
-- Deliberately stores ONLY business fields (no customer name/address/phone PII).
-- Feeds the QC-fail vendor factor (sd_vendor_return_qc); vendor is attributed via
-- sku -> most-recent PO vendor in sd_po_master_raw (returns carry no vendor).
create table if not exists public.sd_ee_return (
  row_key             text primary key,   -- credit_note_id | suborder_id | sku
  credit_note_id      bigint,
  invoice_id          bigint,
  order_id            bigint,
  reference_code      text,
  replacement_order   integer,            -- 0 = return, 1 = exchange
  return_type         text,
  return_date         date,
  credit_note_date    date,
  marketplace         text,
  company_name        text,
  sku                 text,
  product_id          bigint,
  company_product_id  bigint,
  suborder_id         bigint,
  return_reason       text,
  inventory_status    text,               -- "QC Pass" / "QC Fail" / ... (the quality signal)
  returned_qty        numeric,
  synced_at           timestamptz not null default now()
);
create index if not exists sd_ee_return_sku_idx on public.sd_ee_return (sku);
create index if not exists sd_ee_return_qc_idx on public.sd_ee_return (inventory_status);
create index if not exists sd_ee_return_repl_idx on public.sd_ee_return (replacement_order);

alter table public.sd_ee_return enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='sd_ee_return' and policyname='saadaa read sd_ee_return') then
    create policy "saadaa read sd_ee_return" on public.sd_ee_return for select to authenticated using (public.sd_is_saadaa());
  end if;
end $$;
