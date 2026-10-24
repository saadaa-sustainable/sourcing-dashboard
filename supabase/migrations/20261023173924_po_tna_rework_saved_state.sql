alter table public.sd_po_approval add column tna_rework_saved_at timestamptz;
create or replace function public.sd_guard_po_section_rework()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  allowed text[] := array[
    'status','submitted_for_approval_at','requested_total_days','rejection_notes',
    'in_buying_plan','plan_qty_at_submit','submit_remark','updated_at',
    'tna_confirmed','tna_confirmed_at','tna_confirmed_by','tna_rework_saved_at'
  ];
begin
  if new.status = 'rework' and old.status is distinct from 'rework' then
    new.tna_rework_saved_at := null;
  end if;
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
  if old.status = 'rework' and old.rework_sections @> array['tna']::text[]
     and new.status in ('submitted','pending_l2')
     and (new.tna_rework_saved_at is null or new.tna_rework_saved_at < old.reworked_at) then
    raise exception 'Save the TNA rework before submitting this PO again.';
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
