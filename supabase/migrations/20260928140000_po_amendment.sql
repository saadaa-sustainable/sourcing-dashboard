-- =====================================================================
-- PO Amendment (spec 7.9) — a change to a PO that has ALREADY been issued in EasyEcom.
--
-- Three kinds: cost (the rate per piece), quantity (pieces ordered), time (the delivery
-- date). Each is its own request, raised against a real issued PO (the EasyEcom feed,
-- sd_po_filtered), with the PO's current figure captured beside the new one so the
-- approver and Finance see exactly what moved. The reason is mandatory, and so is the
-- day the change was agreed with the vendor: Finance accepts an amendment only when it
-- was recorded on that day, so the request is refused otherwise.
--
-- Same approval ladder as every other request table, so decideApproval / ApprovalBar /
-- the log / the escalation matrix work unchanged. Approval is the RECORD Finance acts on;
-- the PO itself lives in EasyEcom and is changed there — the dashboard reflects, it does
-- not own.
-- =====================================================================

create table if not exists public.sd_po_amendment (
  id                    bigserial primary key,
  -- The issued PO, as the EasyEcom feed names it.
  po_ref_num            text not null,
  po_number             text,
  vendor_code           text,
  vendor_name           text,
  product_codes         text,
  -- The dashboard's own PO request behind it, when one matches by reference.
  po_approval_id        bigint,
  amendment_type        text not null check (amendment_type in ('cost', 'quantity', 'time')),
  -- The figure on the PO when the amendment was raised, and what it should become.
  current_rate          numeric,
  new_rate              numeric,
  current_qty           numeric,
  new_qty               numeric,
  current_delivery_date date,
  new_delivery_date     date,
  -- Finance's condition: entered the same day it was agreed with the vendor.
  agreed_with_vendor_on date not null,
  reason                text not null,
  evidence_url          text,
  -- Approval ladder, identical to the other request tables.
  status                public.sd_status not null default 'draft',
  requested_by          text,
  requested_at          timestamptz,
  approved_by           text,
  approved_at           timestamptz,
  rejection_notes       text,
  rework_notes          text,
  reworked_by           text,
  reworked_at           timestamptz,
  edited_before_approval boolean not null default false,
  created_at            timestamptz not null default now()
);
create index if not exists sd_po_amendment_po_idx on public.sd_po_amendment (po_ref_num);

-- One OPEN amendment of a kind per PO. Approved and rejected ones stay as history, and a
-- second cost change can follow the first once it is decided.
create unique index if not exists sd_po_amendment_live_unique
  on public.sd_po_amendment (upper(trim(po_ref_num)), amendment_type)
  where status in ('draft', 'submitted', 'pending_l2', 'rework');

alter table public.sd_po_amendment enable row level security;
grant select, insert, update, delete on public.sd_po_amendment to authenticated;
grant usage, select on sequence public.sd_po_amendment_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_amendment' and policyname='saadaa read sd_po_amendment') then
    execute 'create policy "saadaa read sd_po_amendment" on public.sd_po_amendment
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_amendment' and policyname='sourcing write sd_po_amendment') then
    execute 'create policy "sourcing write sd_po_amendment" on public.sd_po_amendment
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;

-- The issued POs an amendment can be raised against: one row per open EasyEcom PO,
-- aggregated in SQL (26,000 lines → ~700 POs) so the picker never pages raw lines.
-- rate = quantity-weighted item price; the delivery date is the latest line's.
create or replace function public.sd_issued_pos()
returns table (
  po_ref_num text, po_number text, vendor_code text, vendor_name text, po_status text,
  product_codes text, lines int, ordered_qty numeric, pending_qty numeric, rate numeric,
  po_date date, expected_delivery_date date
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    trim(f.po_ref_num),
    max(f.po_number),
    max(f.vendor_code),
    max(f.vendor_name),
    max(f.po_status),
    string_agg(distinct f.product_code, ', ' order by f.product_code),
    count(*)::int,
    coalesce(sum(f.original_qty), 0),
    coalesce(sum(f.pending_qty), 0),
    round((sum(f.original_qty * f.item_price) / nullif(sum(f.original_qty), 0))::numeric, 2),
    min(f.po_date),
    max(f.expected_delivery_date)
  from public.sd_po_filtered f
  where coalesce(trim(f.po_ref_num), '') <> ''
  group by trim(f.po_ref_num)
  order by min(f.po_date) desc, trim(f.po_ref_num);
$$;
grant execute on function public.sd_issued_pos() to authenticated;
