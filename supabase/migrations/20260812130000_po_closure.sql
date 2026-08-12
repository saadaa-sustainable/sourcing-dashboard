-- =====================================================================
-- PO submission / closure — a lightweight per-PO closure decision that lives
-- below the main PO Approval table. Row-wise Yes/No (approved/rejected) against
-- the open (issued) POs, using the same sd_status set as everywhere else.
-- =====================================================================

create table if not exists public.sd_po_closure (
  po_number   text primary key,
  status      public.sd_status not null default 'draft',
  decided_by  text,
  decided_at  timestamptz,
  note        text,
  updated_at  timestamptz not null default now()
);

alter table public.sd_po_closure enable row level security;
grant select, insert, update on public.sd_po_closure to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_closure' and policyname='saadaa read sd_po_closure') then
    execute 'create policy "saadaa read sd_po_closure" on public.sd_po_closure
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_po_closure' and policyname='sourcing write sd_po_closure') then
    execute 'create policy "sourcing write sd_po_closure" on public.sd_po_closure
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
