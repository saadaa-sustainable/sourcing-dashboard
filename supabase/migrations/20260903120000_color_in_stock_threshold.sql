-- Item 1 (approval context panel): the size-in-stock fraction at/above which a
-- colour counts as "in stock" for the Color In-Stock Rate rollup. Rules-Master
-- configurable, not hardcoded. (Applied to Supabase 2026-09-03.)
insert into public.sd_analytics_rule (rule_key, value, label, description) values
  ('color_in_stock_threshold', 0.75, 'Color In-Stock Rate — size threshold',
   'A colour counts as in-stock when at least this fraction of its sizes are in stock (0.75 = 75%). Drives the approval-screen Color In-Stock Rate = colours meeting this / total colours.')
on conflict (rule_key) do nothing;
