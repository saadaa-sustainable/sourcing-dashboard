-- The daily inventory report to Slack is not wanted (team, 2026-09-28). The feature is
-- removed from the dashboard and from BqSync.gs; this takes its Rules Master switch out.
-- The sd_inventory_report table and the inventory-reports bucket are left in place: a few
-- days of stored CSVs, harmless, and dropping storage is not a migration's job.
delete from public.sd_analytics_rule where rule_key = 'inventory_report_slack';
