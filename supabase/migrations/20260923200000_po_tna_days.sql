-- Spec 7.3 — the critical path is entered as DAYS and derived from the EasyCom PO
-- issue date, not typed as six dates that are only true if the PO issues on time.
--
-- The three date logs it names are already here and stay where they are:
--   submitted_for_approval_at  request raised
--   approved_at                approved internally
--   po_issued_at               PO created in EasyCom  ← day 0 of the critical path
--
-- What is new is the days, so a PO that issues ten days late moves its whole path with
-- it instead of quietly keeping dates nobody can hit.

alter table public.sd_po_approval
  add column if not exists tna_days_pp_sample      int,
  add column if not exists tna_days_gpt            int,
  add column if not exists tna_days_cutting        int,
  add column if not exists tna_days_inline_qc      int,
  add column if not exists tna_days_first_delivery int,
  add column if not exists tna_days_po_closing     int,
  -- The date the stored stage dates were last computed from, and when that happened.
  -- Both are for reading back "what was this schedule based on", never for the maths.
  add column if not exists tna_base_date  date,
  add column if not exists tna_rebased_at timestamptz;

comment on column public.sd_po_approval.tna_days_cutting is
  'Days from the EasyCom PO issue date to cutting start. Days are the stored plan; the dates are derived.';
comment on column public.sd_po_approval.tna_base_date is
  'What the stored cs_* dates were computed from — the EasyCom issue date once the PO exists there.';

-- Back-fill. Each row keeps the dates it already has: the days are measured against the
-- start those dates imply (its PP-sample date minus the standard PP-sample lead time), so
-- recomputing from days reproduces exactly the dates on screen today. A row with no
-- PP-sample date falls back to the standard lead times.
with std as (select * from public.sd_tna_leadtimes where id = 1)
update public.sd_po_approval p
   set tna_base_date = coalesce(p.tna_base_date, p.cs_pp_sample_due - std.pp_sample_days),
       tna_days_pp_sample      = coalesce(p.tna_days_pp_sample,      p.cs_pp_sample_due            - (p.cs_pp_sample_due - std.pp_sample_days), std.pp_sample_days),
       tna_days_gpt            = coalesce(p.tna_days_gpt,            p.cs_gpt_due                  - (p.cs_pp_sample_due - std.pp_sample_days), std.gpt_days),
       tna_days_cutting        = coalesce(p.tna_days_cutting,        p.cs_cutting_start            - (p.cs_pp_sample_due - std.pp_sample_days), std.cutting_days),
       tna_days_inline_qc      = coalesce(p.tna_days_inline_qc,      p.cs_inline_qc_due            - (p.cs_pp_sample_due - std.pp_sample_days), std.inline_qc_days),
       tna_days_first_delivery = coalesce(p.tna_days_first_delivery, p.critical_path_first_delivery - (p.cs_pp_sample_due - std.pp_sample_days), std.first_delivery_days),
       tna_days_po_closing     = coalesce(p.tna_days_po_closing,     p.po_closing_date             - (p.cs_pp_sample_due - std.pp_sample_days), std.po_closing_days)
  from std
 where p.tna_days_cutting is null;
