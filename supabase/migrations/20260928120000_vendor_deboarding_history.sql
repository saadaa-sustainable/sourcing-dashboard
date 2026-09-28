-- =====================================================================
-- Vendor de-boarding — the Google Form era, brought onto the dashboard.
--
-- Before the dashboard form (2026-09-21) de-boardings were raised on a Google Form and
-- landed on the "VENDOR DE-BOARDING FORM" tab of the NEW VENDOR SOURCING & EMPANNELMENT
-- sheet: 31 responses, Nov 2024 – Sep 2026. They are the record of who was de-listed and
-- why, so they live here, read-only, beside the dashboard's own requests.
--
-- Kept as its own table rather than forced into sd_vendor_deboarding_request: the form
-- allowed SEVERAL reasons per vendor (the dashboard form allows one), it had no approval
-- ladder, and a historical record must not look like a request awaiting a decision.
-- =====================================================================

create table if not exists public.sd_vendor_deboarding_history (
  id                bigserial primary key,
  submitted_at      timestamptz not null,
  submitted_by      text,
  vendor_code       text not null,
  vendor_name       text,
  pos_done          integer,
  -- the form's multi-select, as written: e.g. {"DELAY IN MEETING TIMELINES","QUALITY ISSUE"}
  reasons           text[] not null default '{}',
  behaviour_score   smallint,
  work_style_score  smallint,
  quality_score     smallint,
  process_score     smallint,
  pos_late_15d      integer,
  pos_late_1m       integer,
  pos_late_over_1m  integer,
  rejection_pct     numeric(6,2),
  resolvable        boolean,
  remarks           text,
  ee_status         text,       -- "Status in EE" column on the sheet
  note              text,       -- the sheet's unlabelled last column (e.g. "Nov 2025")
  source            text not null default 'google_form',
  imported_at       timestamptz not null default now(),
  unique (submitted_at, vendor_code)
);
create index if not exists sd_vendor_deboarding_history_code_idx
  on public.sd_vendor_deboarding_history (vendor_code);

alter table public.sd_vendor_deboarding_history enable row level security;
grant select, insert, update, delete on public.sd_vendor_deboarding_history to authenticated;
grant usage, select on sequence public.sd_vendor_deboarding_history_id_seq to authenticated;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_vendor_deboarding_history'
                 and policyname='saadaa read sd_vendor_deboarding_history') then
    execute 'create policy "saadaa read sd_vendor_deboarding_history" on public.sd_vendor_deboarding_history
               for select to authenticated using (public.sd_is_saadaa())';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='sd_vendor_deboarding_history'
                 and policyname='sourcing write sd_vendor_deboarding_history') then
    execute 'create policy "sourcing write sd_vendor_deboarding_history" on public.sd_vendor_deboarding_history
               for all to authenticated using (public.sd_can_write()) with check (public.sd_can_write())';
  end if;
end $$;

-- The 31 responses are loaded by the one-off import (scratch SQL generated from the
-- sheet's CSV export on 2026-09-28); re-running it is a no-op on (submitted_at, vendor_code).
