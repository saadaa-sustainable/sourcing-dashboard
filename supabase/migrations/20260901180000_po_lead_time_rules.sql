-- =====================================================================
-- PO-type lead times in the editable Rules Master (spec §7).
--
-- Job Work / E-FOB / FOB lead-time day-counts live in sd_analytics_rule (the
-- existing editable Rules Master), NOT hardcoded — so the Buying Plan's 30/45/90
-- time-bucket views read them and an admin can change them (esp. FOB, which was
-- stated as 75 in one session and up-to-90 in another). Seeded 30 / 45 / 90.
-- =====================================================================

insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('lead_days_job',  30, 'Lead time — Job Work (days)',
   'Job Work: fabric already on hand, shortest window. Drives the Buying Plan time-bucket.'),
  ('lead_days_efob', 45, 'Lead time — E-FOB (days)',
   'E-FOB: extra time for fabric verification (company cash is at risk).'),
  ('lead_days_fob',  90, 'Lead time — FOB (days)',
   'FOB: vendor holds stock, longest window. Sessions ranged 75–90; editable here.')
on conflict (rule_key) do nothing;
