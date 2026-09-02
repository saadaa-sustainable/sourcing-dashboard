-- =====================================================================
-- Rules Master completeness: seed sync_stale_hours.
--
-- The Sync Health card's info text says its stale threshold is "editable in
-- Rules Master", but sync_stale_hours only existed as a code default — it had
-- no sd_analytics_rule row, so saveAnalyticsRule's UPDATE was a silent no-op.
-- Seed it (matching ANALYTICS_RULE_DEFAULTS = 30h) so the new Rules Master
-- screen can actually edit it, like every other referenced threshold.
-- =====================================================================

insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('sync_stale_hours', 30, 'Data feed — stale after (hours)',
   'A synced feed is flagged stale on the Sync Health card after this many hours without a refresh.')
on conflict (rule_key) do nothing;
