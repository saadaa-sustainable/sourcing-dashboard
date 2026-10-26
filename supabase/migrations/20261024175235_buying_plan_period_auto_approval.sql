-- Clarified lifecycle: overdue CURRENT pending plans become Approved; PAST
-- pending/unstarted plans become approved and the existing date rule closes them.
-- Future plans and explicit rework/rejection decisions are preserved.
create or replace function sd_plan_workflow.auto_approve() returns integer
language plpgsql security invoker set search_path = '' as $$
declare
  p public.sd_buying_plan%rowtype;
  deadline_day integer;
  current_month date := date_trunc('month', transaction_timestamp() at time zone 'Asia/Kolkata')::date;
  approved_count integer := 0;
  changed_lines integer;
begin
  select greatest(1, least(28, round(value)::integer)) into deadline_day
    from public.sd_analytics_rule where rule_key='plan_approval_deadline_day';
  deadline_day := coalesce(deadline_day, 7);
  for p in select * from public.sd_buying_plan
    where (plan_month < current_month and status in ('draft','submitted','pending_l2'))
      or (plan_month = current_month and status in ('submitted','pending_l2')
        and transaction_timestamp() >= ((plan_month + deadline_day)::timestamp at time zone 'Asia/Kolkata'))
    order by id for update skip locked
  loop
    perform id from public.sd_buying_plan_line where plan_id=p.id order by id for update;
    -- A null per-line status is a legacy undecided line, not an approver decision.
    -- Never override explicit rework/rejection, or label an all-rejected plan approved.
    if exists (select 1 from public.sd_buying_plan_line where plan_id=p.id
      and job_work_qty+fob_qty+efob_qty>0 and line_status='rework') then continue; end if;
    if not exists (select 1 from public.sd_buying_plan_line where plan_id=p.id
      and job_work_qty+fob_qty+efob_qty>0 and (line_status is null or line_status in ('draft','submitted','pending_l2','approved')))
      and (p.plan_month=current_month or exists (select 1 from public.sd_buying_plan_line
        where plan_id=p.id and job_work_qty+fob_qty+efob_qty>0)) then continue; end if;
    update public.sd_buying_plan_line set line_status='approved',auto_approved=true,rework_notes=null
      where plan_id=p.id and job_work_qty+fob_qty+efob_qty>0
        and (line_status is null or line_status in ('draft','submitted','pending_l2'));
    get diagnostics changed_lines = row_count;
    update public.sd_buying_plan set status='approved',auto_approved=true,
      approved_at=transaction_timestamp(),approved_by='workflow@buying-plan' where id=p.id;
    insert into public.sd_approval_log(entity_type,entity_id,entity_label,from_status,to_status,actor_email,notes)
      values ('buying_plan',p.id::text,'Buying plan ' || to_char(p.plan_month,'YYYY-MM'),p.status,'approved',
        'workflow@buying-plan','Auto-Approved via Workflow: ' ||
        case when p.plan_month<current_month then 'past-month pending / not-started plan; closed under the existing month-freeze rule'
          else 'approval TAT expired (Rules Master day ' || deadline_day || ', EOD IST); moved to Approved' end
        || '; ' || changed_lines || ' undecided line(s) approved.');
    approved_count := approved_count+1;
  end loop;
  return approved_count;
end;
$$;
revoke all on function sd_plan_workflow.auto_approve() from public,anon,authenticated;
-- The existing every-minute cron job already calls this function.
