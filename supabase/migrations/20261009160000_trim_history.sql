-- Standard Cost → Trim History (2026-10-09). User: "Along with rate history we also need a tab
-- of Trim History, that will record all the changes made in any trim (Product Trims and Brand
-- Trims) values". Team spec: "Separate history document from general costing history. Highest
-- variability item, drives the cost gaps".
--
-- One append-only row per change to a trim line of a product's CMTP (any head whose name holds
-- "trim": Product Trims, Brand Trims, or a custom trim head). Unlike sd_cmtp_revision (logged only
-- on a revision of an existing breakdown), EVERY change is recorded — the first entry too.
--   change_kind: 'added' | 'changed' | 'removed' | 'on_file' (baseline written by this migration)

create table if not exists public.sd_trim_history (
  id           bigint generated always as identity primary key,
  product_code text not null,
  trim_head    text not null,          -- CMTP head: Product Trims / Brand Trims / custom trim head
  item         text,                   -- trim within the head (Fusing, Button …); null = plain head amount
  old_amount   numeric,                -- null = added
  new_amount   numeric,                -- null = removed
  change_kind  text not null check (change_kind in ('added', 'changed', 'removed', 'on_file')),
  reason       text,
  changed_by   text,
  changed_at   timestamptz not null default now()
);

create index if not exists sd_trim_history_product_idx on public.sd_trim_history (product_code, changed_at desc);
create index if not exists sd_trim_history_item_idx on public.sd_trim_history (item, changed_at desc);

alter table public.sd_trim_history enable row level security;
drop policy if exists sd_trim_history_read on public.sd_trim_history;
create policy sd_trim_history_read on public.sd_trim_history
  for select to authenticated using ((select public.sd_is_saadaa()));
drop policy if exists sd_trim_history_write on public.sd_trim_history;
create policy sd_trim_history_write on public.sd_trim_history
  for insert to authenticated with check ((select public.sd_can_write()));
grant select, insert on public.sd_trim_history to authenticated;

-- Backfill 1: trim changes already in the CMTP revision log.
insert into public.sd_trim_history (product_code, trim_head, item, old_amount, new_amount, change_kind, reason, changed_by, changed_at)
select r.product_code, r.category, r.label, r.old_amount, r.new_amount,
       case when r.old_amount is null then 'added' when r.new_amount is null then 'removed' else 'changed' end,
       r.reason, r.revised_by, r.revised_at
from public.sd_cmtp_revision r
where r.category ilike '%trim%'
  and not exists (select 1 from public.sd_trim_history h where h.product_code = r.product_code);

-- Backfill 2: a baseline row for every trim line on file that has no history yet, dated when the
-- line was last saved, so each item's history starts from its value today.
insert into public.sd_trim_history (product_code, trim_head, item, old_amount, new_amount, change_kind, reason, changed_by, changed_at)
select c.product_code, c.category, nullif(c.label, ''), null, c.amount, 'on_file',
       'Value on file when trim history started', null, c.created_at
from public.sd_cmtp_component c
where c.category ilike '%trim%'
  and c.amount is not null
  and not exists (
    select 1 from public.sd_trim_history h
    where h.product_code = c.product_code and h.trim_head = c.category
      and coalesce(h.item, '') = coalesce(nullif(c.label, ''), '')
  );

do $$
begin
  if to_regprocedure('public.sd_audit_trigger()') is not null then
    drop trigger if exists sd_audit on public.sd_trim_history;
    create trigger sd_audit after insert or update or delete on public.sd_trim_history
      for each row execute function public.sd_audit_trigger('id');
  end if;
end $$;
