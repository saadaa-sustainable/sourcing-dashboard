-- Spec 7.1: the remark typed on the pre-submission pop-up (the three validations) travels
-- with the PO so the approver reads it beside the numbers.
alter table public.sd_po_approval add column if not exists submit_remark text;
