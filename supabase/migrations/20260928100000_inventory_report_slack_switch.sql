-- Off switch for the daily inventory report's Slack post, editable in Rules Master.
-- 1 = post to the Supply Chain channel after the morning sync, 0 = build and store the
-- file but send nothing. Set to 0 on 2026-09-28 at the team's request.
insert into public.sd_analytics_rule (rule_key, value, label, description, updated_at, updated_by)
values (
  'inventory_report_slack', 0,
  'Daily inventory report to Slack (1 = on, 0 = off)',
  'Whether the morning inventory report is posted to the Supply Chain Slack channel after the BigQuery sync lands. 0 switches the Slack post off; the CSV is still built and stored.',
  now(), 'system'
)
on conflict (rule_key) do update
  set label = excluded.label, description = excluded.description;
