-- Pending FG and Material plans expire at midnight IST after the Rules Master day.
-- No historical rows are changed by applying this migration; the scheduled job
-- processes overdue pending plans on its next run, including historical backlog.
alter table public.sd_buying_plan add column auto_approved boolean not null default false;
alter table public.sd_buying_plan_line add column auto_approved boolean not null default false;

create schema if not exists sd_plan_workflow;
revoke all on schema sd_plan_workflow from public, anon, authenticated;

-- Keep the provenance only while the record remains approved. Users cannot forge it.
create function sd_plan_workflow.provenance_guard() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare next_status text;
begin
  next_status := case when tg_table_name='sd_buying_plan' then to_jsonb(new)->>'status' else to_jsonb(new)->>'line_status' end;
  if new.auto_approved and (tg_op='INSERT' or not old.auto_approved)
     and current_user not in ('postgres', 'service_role') then
    raise exception 'Only the workflow can mark automatic approval';
  end if;
  if next_status is distinct from 'approved' then new.auto_approved := false; end if;
  return new;
end;
$$;
create trigger buying_plan_auto_provenance before insert or update on public.sd_buying_plan
for each row execute function sd_plan_workflow.provenance_guard();
create trigger buying_plan_line_auto_provenance before insert or update on public.sd_buying_plan_line
for each row execute function sd_plan_workflow.provenance_guard();

create function sd_plan_workflow.auto_approve() returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  p public.sd_buying_plan%rowtype;
  deadline_day integer;
  approved_count integer := 0;
  changed_lines integer;
begin
  select greatest(1, least(28, round(value)::integer)) into deadline_day
    from public.sd_analytics_rule where rule_key='plan_approval_deadline_day';
  deadline_day := coalesce(deadline_day, 7);
  for p in select * from public.sd_buying_plan
    where status in ('submitted','pending_l2')
      and submitted_at is not null
      and transaction_timestamp() >= ((plan_month + deadline_day)::timestamp at time zone 'Asia/Kolkata')
    order by id for update skip locked
  loop
    -- Lock all lines before rechecking so manual line decisions cannot be overwritten.
    perform id from public.sd_buying_plan_line where plan_id=p.id order by id for update;
    -- Never override a rework decision or approve an empty/all-rejected plan.
    if not exists (select 1 from public.sd_buying_plan_line where plan_id=p.id
      and job_work_qty+fob_qty+efob_qty>0 and line_status in ('submitted','pending_l2'))
      or exists (select 1 from public.sd_buying_plan_line where plan_id=p.id
        and job_work_qty+fob_qty+efob_qty>0
        and (line_status is null or line_status not in ('submitted','pending_l2','approved','rejected')))
    then continue; end if;
    update public.sd_buying_plan_line set line_status='approved', auto_approved=true, rework_notes=null
      where plan_id=p.id and job_work_qty+fob_qty+efob_qty>0 and line_status in ('submitted','pending_l2');
    get diagnostics changed_lines = row_count;
    update public.sd_buying_plan set status='approved', auto_approved=true,
      approved_at=transaction_timestamp(), approved_by='workflow@buying-plan'
      where id=p.id;
    insert into public.sd_approval_log(entity_type,entity_id,entity_label,from_status,to_status,actor_email,notes)
      values ('buying_plan',p.id::text,'Buying plan ' || to_char(p.plan_month,'YYYY-MM'),p.status,'approved',
        'workflow@buying-plan','Auto-Approved via Workflow: approval TAT expired (Rules Master day '
        || deadline_day || ', EOD IST); ' || changed_lines || ' pending line(s) approved.');
    approved_count := approved_count+1;
  end loop;
  return approved_count;
end;
$$;
revoke all on all functions in schema sd_plan_workflow from public, anon, authenticated;

-- Existing project infrastructure already uses pg_cron. Run independently of page visits.
select cron.schedule('buying-plan-auto-approval', '* * * * *', 'select sd_plan_workflow.auto_approve()');
notify pgrst, 'reload schema';
