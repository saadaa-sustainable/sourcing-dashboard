-- =====================================================================
-- TNA lead-times — the standard day-offsets used to AUTO-GENERATE a PO's
-- critical path (no manual sheet-pulling). Documented once (singleton); each
-- stage date = the TNA start date + its offset in days.
-- =====================================================================

create table if not exists public.sd_tna_leadtimes (
  id                  integer primary key default 1,
  pp_sample_days      integer,
  gpt_days            integer,
  cutting_days        integer,
  inline_qc_days      integer,
  first_delivery_days integer,
  po_closing_days     integer,
  updated_by          text,
  updated_at          timestamptz not null default now(),
  constraint sd_tna_leadtimes_singleton check (id = 1)
);
-- Sensible defaults (editable): a ~50-day critical path.
insert into public.sd_tna_leadtimes
  (id, pp_sample_days, gpt_days, cutting_days, inline_qc_days, first_delivery_days, po_closing_days)
values (1, 7, 14, 21, 30, 45, 50)
on conflict (id) do nothing;

alter table public.sd_tna_leadtimes enable row level security;
grant select, insert, update on public.sd_tna_leadtimes to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_tna_leadtimes' and policyname='saadaa read sd_tna_leadtimes') then
    execute 'create policy "saadaa read sd_tna_leadtimes" on public.sd_tna_leadtimes
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_tna_leadtimes' and policyname='sourcing write sd_tna_leadtimes') then
    execute 'create policy "sourcing write sd_tna_leadtimes" on public.sd_tna_leadtimes
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;
