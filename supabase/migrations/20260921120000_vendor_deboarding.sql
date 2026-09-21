-- Vendor De-Boarding: the Google Form ("VENDOR DE-BOARDING FORM") brought onto the
-- dashboard as a request that goes through the shared approval queue. Same shape as
-- sd_discontinue_request so decideApproval / ApprovalBar / the log work unchanged.
--
-- The form typed five numbers by hand (POs done, three delay counts, rejection %). The
-- dashboard already holds the data those come from, so sd_vendor_deboarding_stats below
-- computes them per vendor and the form pre-fills; the person raising the request can
-- still overwrite, and what they submit is what is stored.

create table public.sd_vendor_deboarding_request (
  id                bigserial primary key,
  vendor_code       text not null,
  vendor_name       text,
  -- Why: the form's single-choice reason, plus free text when it is "other".
  reason            text not null
    check (reason in ('behavioural', 'delay', 'quality', 'unethical', 'process_gap', 'other')),
  reason_other      text,
  -- The form's four 1-5 ratings.
  behaviour_score   smallint not null check (behaviour_score between 1 and 5),
  work_style_score  smallint not null check (work_style_score between 1 and 5),
  quality_score     smallint not null check (quality_score between 1 and 5),
  process_score     smallint not null check (process_score between 1 and 5),
  -- The form's counted evidence. Pre-filled from completed-PO data, editable.
  pos_done          integer not null default 0 check (pos_done >= 0),
  pos_late_15d      integer not null default 0 check (pos_late_15d >= 0),
  pos_late_1m       integer not null default 0 check (pos_late_1m >= 0),
  pos_late_over_1m  integer not null default 0 check (pos_late_over_1m >= 0),
  rejection_pct     numeric(6,2) check (rejection_pct is null or rejection_pct between 0 and 100),
  resolvable        boolean not null,
  remarks           text not null,
  -- Approval ladder, identical to the other request tables.
  status            public.sd_status not null default 'draft',
  requested_by      text,
  requested_at      timestamptz,
  approved_by       text,
  approved_at       timestamptz,
  rejection_notes   text,
  rework_notes      text,
  reworked_by       text,
  reworked_at       timestamptz,
  edited_before_approval boolean not null default false
);

-- One live request per vendor. A rejected one can be raised again later.
create unique index sd_vendor_deboarding_live_unique
  on public.sd_vendor_deboarding_request (upper(vendor_code))
  where status <> 'rejected';

alter table public.sd_vendor_deboarding_request enable row level security;
create policy "saadaa read sd_vendor_deboarding_request"
  on public.sd_vendor_deboarding_request for select using (sd_is_saadaa());
create policy "sourcing write sd_vendor_deboarding_request"
  on public.sd_vendor_deboarding_request for all
  using (sd_can_write()) with check (sd_can_write());

-- Per-vendor evidence from completed POs, one row per vendor code.
--   pos_done         distinct POs the vendor has completed
--   pos_late_15d     completed 15-29 days after the expected delivery date
--   pos_late_1m      completed 30-60 days after it
--   pos_late_over_1m completed more than 60 days after it
-- A PO's completion date is its last update date on the completed feed; a PO with no
-- expected date counts in pos_done and in no delay bucket.
create or replace view public.sd_vendor_deboarding_stats as
with po as (
  select upper(trim(vendor_code)) as vendor_code,
         po_ref_num,
         max(expected_delivery_date) as edd,
         max(po_updated_date)        as done_on
  from public.sd_po_completed
  where coalesce(trim(vendor_code), '') <> ''
  group by upper(trim(vendor_code)), po_ref_num
)
select vendor_code,
       count(*)::int                                                        as pos_done,
       count(*) filter (where done_on - edd between 15 and 29)::int          as pos_late_15d,
       count(*) filter (where done_on - edd between 30 and 60)::int          as pos_late_1m,
       count(*) filter (where done_on - edd > 60)::int                       as pos_late_over_1m
from po
group by vendor_code;

grant select on public.sd_vendor_deboarding_stats to authenticated;
