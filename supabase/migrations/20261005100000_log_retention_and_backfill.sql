-- Long-term storage, rule 1 + rule 6.
--
-- Rule 6: five columns were added to sd_po_approval by hand and never had a migration.
-- Recording them here so a rebuild from migrations matches the live schema.
alter table public.sd_po_approval
  add column if not exists estimated_qty numeric,
  add column if not exists payment_type  text,
  add column if not exists fabric_rate   numeric,
  add column if not exists fabric_qty    numeric,
  add column if not exists remarks       text;

-- Rule 1: the webhook and sync logs are operational noise, not history. Each event they
-- record has already landed in its real table (sd_inventory, sd_ee_grn, the synced tables).
-- Keep 90 days for debugging, drop the rest. Authored data is never touched here.
create or replace function public.sd_prune_logs(keep_days int default 90)
returns table (table_name text, rows_deleted bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => keep_days);
  n bigint;
begin
  delete from public.sd_inventory_webhook_log where received_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sd_inventory_webhook_log'; rows_deleted := n; return next;

  delete from public.sd_grn_webhook_log where received_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sd_grn_webhook_log'; rows_deleted := n; return next;

  delete from public.sync_log where started_at < cutoff;
  get diagnostics n = row_count;
  table_name := 'sync_log'; rows_deleted := n; return next;
end;
$$;

revoke all on function public.sd_prune_logs(int) from public, anon, authenticated;

-- Daily at 02:15 IST (20:45 UTC).
select cron.unschedule(jobid) from cron.job where jobname = 'prune-logs-daily';
select cron.schedule('prune-logs-daily', '45 20 * * *', 'select public.sd_prune_logs(90)');
