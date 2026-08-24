-- new_size never got a source and was removed from the OOS Calculation view.
alter table public.sd_oos_calculation drop column if exists new_size;
