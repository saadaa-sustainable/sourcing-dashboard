-- Saved with each capacity row; existing audit trigger captures changes.
alter table public.sd_vendor_capacity_log add column if not exists update_reason text;
comment on column public.sd_vendor_capacity_log.update_reason is 'Reason for overutilized capacity or fewer than 15 active karigars.';
notify pgrst, 'reload schema';
