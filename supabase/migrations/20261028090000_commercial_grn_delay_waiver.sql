-- Extend the existing request type constraint. GRN fields use the existing details JSON.
begin;
alter table public.sd_vendor_commercial_request
  drop constraint sd_vendor_commercial_request_request_type_check;
alter table public.sd_vendor_commercial_request
  add constraint sd_vendor_commercial_request_request_type_check
  check (request_type in ('hold_waiver', 'cost_increment', 'cash_discount', 'dn_removal', 'credit_note', 'grn_delay_waiver'));
commit;
