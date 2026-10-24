-- NULL means legacy/unscoped rework: preserve existing amend-until-approved behavior.
alter table public.sd_po_approval
  add column rework_sections text[] default null,
  add constraint sd_po_rework_sections_valid check (
    rework_sections is null or (
      cardinality(rework_sections) between 1 and 3 and
      rework_sections <@ array['cost','tna','sku']::text[] and
      array_position(rework_sections, null) is null
    )
  );

-- Invoker trigger: adds no grants, RLS bypass, or callable business mutation.
create function public.sd_guard_po_section_rework()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  allowed text[] := array[
    'status','submitted_for_approval_at','requested_total_days','rejection_notes',
    'in_buying_plan','plan_qty_at_submit','submit_remark','updated_at',
    'tna_confirmed','tna_confirmed_at','tna_confirmed_by'
  ];
begin
  if old.status = 'rework' and old.rework_sections is not null then
    if new.rework_sections is distinct from old.rework_sections then
      raise exception 'Rework sections cannot be changed during resubmission.';
    end if;
    if 'cost' = any(old.rework_sections) then
      allowed := allowed || array['cost_sheet_url','rate','grey_cost','finished_fabric_cost','cm_cost','margin_pct'];
    end if;
    if 'tna' = any(old.rework_sections) then
      allowed := allowed || array[
        'tna_sheet_url','tna_days_pp_sample','tna_days_gpt','tna_days_cutting',
        'tna_days_inline_qc','tna_days_first_delivery','tna_days_po_closing','tna_base_date',
        'cs_pp_sample_due','cs_gpt_due','cs_cutting_start','cs_inline_qc_due',
        'critical_path_first_delivery','po_closing_date'
      ];
    end if;
    if 'sku' = any(old.rework_sections) then
      allowed := allowed || array['po_qty'];
    end if;
    if (to_jsonb(new) - allowed) is distinct from (to_jsonb(old) - allowed) then
      raise exception 'Only sections selected for rework can be changed.';
    end if;
  end if;
  -- A new timeline or quantity needs the approver to confirm it again.
  if (new.status = 'rework' and new.rework_sections is not null and
      new.rework_sections && array['tna','sku']::text[])
    or (old.status = 'rework' and old.rework_sections is not null and (
      new.po_qty is distinct from old.po_qty or
      (to_jsonb(new) -> 'tna_days_pp_sample') is distinct from (to_jsonb(old) -> 'tna_days_pp_sample') or
      (to_jsonb(new) -> 'tna_days_gpt') is distinct from (to_jsonb(old) -> 'tna_days_gpt') or
      (to_jsonb(new) -> 'tna_days_cutting') is distinct from (to_jsonb(old) -> 'tna_days_cutting') or
      (to_jsonb(new) -> 'tna_days_inline_qc') is distinct from (to_jsonb(old) -> 'tna_days_inline_qc') or
      (to_jsonb(new) -> 'tna_days_first_delivery') is distinct from (to_jsonb(old) -> 'tna_days_first_delivery') or
      (to_jsonb(new) -> 'tna_days_po_closing') is distinct from (to_jsonb(old) -> 'tna_days_po_closing')
    )) then
    new.tna_confirmed := false;
    new.tna_confirmed_at := null;
    new.tna_confirmed_by := null;
  end if;
  return new;
end;
$$;
create trigger sd_po_section_rework_guard
  before update on public.sd_po_approval
  for each row execute function public.sd_guard_po_section_rework();
revoke all on function public.sd_guard_po_section_rework() from public, anon, authenticated;

create function public.sd_guard_po_line_section_rework()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  parent_id bigint;
  parent record;
begin
  -- Lock parents in stable order, including both when a line is moved.
  for parent_id in
    select distinct value from unnest(
      case when tg_op = 'INSERT' then array[new.po_id]
           when tg_op = 'DELETE' then array[old.po_id]
           else array[old.po_id, new.po_id] end
    ) value order by value
  loop
    select status, rework_sections into parent from public.sd_po_approval
      where id = parent_id for update;
    if parent.status = 'rework' and parent.rework_sections is not null
       and not ('sku' = any(parent.rework_sections)) then
      raise exception 'SKU quantities were not selected for rework.';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger sd_po_line_section_rework_guard
  before insert or update or delete on public.sd_po_approval_line
  for each row execute function public.sd_guard_po_line_section_rework();
revoke all on function public.sd_guard_po_line_section_rework() from public, anon, authenticated;

comment on column public.sd_po_approval.rework_sections is
  'Approver-selected editable sections during rework: cost, tna, sku. NULL preserves legacy unscoped behavior.';
