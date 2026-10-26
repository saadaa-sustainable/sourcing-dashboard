-- Stage optional Expected and admin-owned targets in rate revisions; apply only on approval.
create or replace function public.sd_cost_snapshot(p_code text) returns jsonb
language sql stable security invoker set search_path = public as $$
 select jsonb_build_object(
 'rates',jsonb_build_object('job_cost',c.job_cost,'fob_cost',c.fob_cost,'efob_cost',c.efob_cost,'total_po_avg_cost',c.total_po_avg_cost,'proposed_cost',c.proposed_cost,'target_job',c.target_job,'target_fob',c.target_fob,'target_efob',c.target_efob),
 'fabric',jsonb_build_object('fabric_code',coalesce(c.fabric_code,''),'fabric_uom',coalesce(c.fabric_uom,'mtr'),
   'lines',coalesce((select jsonb_agg(jsonb_build_object('colour',coalesce(l.colour,''),'size',coalesce(l.size,''),'consumption',l.consumption,'fabric_cost',l.fabric_cost,'cm_cost',l.cm_cost,'total_cost',l.total_cost) order by l.id) from sd_standard_cost_line l where l.product_code=p_code),'[]'::jsonb),
   'extras',coalesce((select jsonb_agg(jsonb_build_object('fabric_code',e.fabric_code,'size',e.size,'position',e.position,'uom',coalesce(e.uom,'mtr'),'consumption',e.consumption,'fabric_cost',e.fabric_cost) order by e.position,e.id) from sd_standard_cost_extra_fabric e where e.product_code=p_code),'[]'::jsonb)),
 'cmtp',coalesce((select jsonb_agg(jsonb_build_object('category',m.category,'label',coalesce(m.label,''),'amount',m.amount,'position',m.position) order by m.position,m.id) from sd_cmtp_component m where m.product_code=p_code),'[]'::jsonb),
 'documents',jsonb_build_object('rfp_link',coalesce(c.rfp_link,''),'cad_link',coalesce(c.cad_link,''),'files',coalesce((select jsonb_agg(jsonb_build_object('file_path',d.file_path,'file_name',d.file_name,'file_size',d.file_size,'doc_group',d.doc_group,'width',d.width,'link_url',d.link_url,'remark',d.remark) order by d.id) from sd_cost_document d where d.product_code=p_code),'[]'::jsonb)))
 from sd_standard_cost c where c.product_code=p_code;
$$;
revoke all on function public.sd_cost_snapshot(text) from public,anon,authenticated;
grant execute on function public.sd_cost_snapshot(text) to service_role;

-- The service-only RPC is called after server authentication, active role and page checks.
-- actor/admin are server-derived, never accepted from a browser form.
create or replace function public.sd_cost_workflow(p_code text,p_op text,p_id bigint,p_version integer,
 p_payload jsonb,p_reason text,p_reference text,p_sections text[],p_actor text,p_admin boolean,p_base jsonb default null)
returns bigint language plpgsql security invoker set search_path=public as $$
declare r sd_cost_revision; c sd_standard_cost; live jsonb; previous jsonb; s text; applied text[]; k text;
begin
 if nullif(trim(p_actor),'') is null then raise exception 'Missing actor'; end if;
 select * into c from sd_standard_cost where product_code=p_code for update;
 if not found then raise exception 'Cost record not found'; end if;
 live := sd_cost_snapshot(p_code);
 if p_id is null then
   if p_op not in ('save','submit') then raise exception 'Save a submission first'; end if;
   if p_base is not null and jsonb_strip_nulls(live) is distinct from jsonb_strip_nulls(p_base) then raise exception 'The approved cost changed. Reload before starting an amendment'; end if;
   if exists(select 1 from sd_cost_revision where product_code=p_code and status<>'approved') then raise exception 'An open submission already exists. Reload to edit it'; end if;
   k := case when c.status='approved' or c.neg_stage='signed_off' or exists(select 1 from sd_standard_cost_rate_history where product_code=p_code) then 'amendment' else 'new' end;
   insert into sd_cost_revision(product_code,kind,owner,base,payload) values(p_code,k,p_actor,live,live) returning * into r;
 else
   select * into r from sd_cost_revision where id=p_id and product_code=p_code for update;
   if not found then raise exception 'Submission not found'; end if;
   if r.version<>p_version then raise exception 'This submission changed. Reload before saving or deciding'; end if;
 end if;
 if r.status='approved' then raise exception 'Approved submissions are locked. Start an amendment'; end if;
 previous := to_jsonb(r);
 if p_op in ('save','submit') then
   if lower(r.owner)<>lower(p_actor) and not p_admin then raise exception 'Only the owner or admin can edit'; end if;
   foreach s in array r.approved_sections loop
     if p_payload->s is distinct from r.payload->s then raise exception 'Section % is already approved',s; end if;
   end loop;
   if not (p_payload ?& array['rates','fabric','cmtp','documents']) then raise exception 'Invalid cost sheet'; end if;
   foreach k in array array['target_job','target_fob','target_efob'] loop
     if not p_admin and coalesce(p_payload#>array['rates',k],'null'::jsonb) is distinct from coalesce(r.payload#>array['rates',k],'null'::jsonb) then raise exception 'Only admin can change target rates'; end if;
   end loop;
   foreach k in array array['proposed_cost','target_job','target_fob','target_efob'] loop
     if coalesce(p_payload#>array['rates',k],'null'::jsonb) <> 'null'::jsonb then
       if jsonb_typeof(p_payload#>array['rates',k]) <> 'number' then raise exception 'Invalid proposal/target amount'; end if;
       if (p_payload#>>array['rates',k])::numeric < 0 then raise exception 'Proposal/target amounts must be nonnegative'; end if;
     end if;
   end loop;
   r.payload:=p_payload; r.reason:=trim(p_reason); r.reference_code:=nullif(p_reference,'');
   r.sections:='{}';
   foreach s in array array['rates','fabric','cmtp','documents'] loop
     if r.kind='new' or r.base->s is distinct from r.payload->s then r.sections:=array_append(r.sections,s); end if;
   end loop;
   if p_op='submit' or r.status in ('pending','rework','rejected') then
     if r.reason='' then raise exception 'A submission / amendment reason is required'; end if;
     if cardinality(r.sections)=0 then raise exception 'No changes to submit'; end if;
     r.status:='pending';
   end if;
   if cardinality(r.approved_sections)>0 and r.sections <@ r.approved_sections then r.status:='approved'; end if;
 elsif p_op in ('approve','reject','rework') then
   if not p_admin then raise exception 'Only admin can decide'; end if;
   if r.status<>'pending' then raise exception 'Only pending submissions can be decided'; end if;
   if p_op='approve' then
     applied:=coalesce(p_sections,'{}');
     if r.kind='new' then applied:=array['rates','fabric','cmtp','documents']; end if;
     if cardinality(applied)=0 then raise exception 'Select sections to approve'; end if;
     -- Target rates are chosen by the approver with the first full cost approval,
     -- never by the submitter. Keep them with the immutable approved payload.
     if r.kind='new' then
       foreach k in array array['target_job','target_fob','target_efob'] loop
         if coalesce(p_payload#>array['rates',k],'null'::jsonb) = 'null'::jsonb
            or jsonb_typeof(p_payload#>array['rates',k]) <> 'number'
            or (p_payload#>>array['rates',k])::numeric < 0 then
           raise exception 'Set all three target rates before approving the first cost';
         end if;
         r.payload := jsonb_set(r.payload, array['rates',k], p_payload#>array['rates',k], true);
       end loop;
     end if;
     foreach s in array applied loop
       if not s=any(r.sections) or s=any(r.approved_sections) then raise exception 'Invalid / already approved section'; end if;
       if jsonb_strip_nulls(live->s) is distinct from jsonb_strip_nulls(r.base->s) then raise exception 'Approved data changed in section %. Reload and reconcile',s; end if;
     end loop;
     perform set_config('sd.cost_workflow','approve',true);
     if 'rates'=any(applied) then
       update sd_standard_cost set job_cost=(r.payload#>>'{rates,job_cost}')::numeric,fob_cost=(r.payload#>>'{rates,fob_cost}')::numeric,
         efob_cost=(r.payload#>>'{rates,efob_cost}')::numeric,total_po_avg_cost=(r.payload#>>'{rates,total_po_avg_cost}')::numeric,
         proposed_cost=case when r.payload->'rates' ? 'proposed_cost' then (r.payload#>>'{rates,proposed_cost}')::numeric else proposed_cost end,
         target_job=case when r.payload->'rates' ? 'target_job' then (r.payload#>>'{rates,target_job}')::numeric else target_job end,
         target_fob=case when r.payload->'rates' ? 'target_fob' then (r.payload#>>'{rates,target_fob}')::numeric else target_fob end,
         target_efob=case when r.payload->'rates' ? 'target_efob' then (r.payload#>>'{rates,target_efob}')::numeric else target_efob end,
         target_cost=case when coalesce(r.payload#>'{rates,target_job}','null'::jsonb) is distinct from coalesce(r.base#>'{rates,target_job}','null'::jsonb) or coalesce(r.payload#>'{rates,target_fob}','null'::jsonb) is distinct from coalesce(r.base#>'{rates,target_fob}','null'::jsonb) or coalesce(r.payload#>'{rates,target_efob}','null'::jsonb) is distinct from coalesce(r.base#>'{rates,target_efob}','null'::jsonb) then null else target_cost end where product_code=p_code;
       insert into sd_standard_cost_rate_history(product_code,job_cost,fob_cost,efob_cost,accepted_by,note)
         values(p_code,(r.payload#>>'{rates,job_cost}')::numeric,(r.payload#>>'{rates,fob_cost}')::numeric,(r.payload#>>'{rates,efob_cost}')::numeric,p_actor,'Workflow #'||r.id||': '||r.reason);
     end if;
     if 'fabric'=any(applied) then
       update sd_standard_cost set fabric_code=r.payload#>>'{fabric,fabric_code}',fabric_uom=r.payload#>>'{fabric,fabric_uom}' where product_code=p_code;
       delete from sd_standard_cost_line where product_code=p_code;
       insert into sd_standard_cost_line(product_code,colour,size,consumption,fabric_cost,cm_cost,total_cost)
         select p_code,x.colour,x.size,x.consumption,x.fabric_cost,x.cm_cost,x.total_cost from jsonb_to_recordset(r.payload#>'{fabric,lines}') as x(colour text,size text,consumption numeric,fabric_cost numeric,cm_cost numeric,total_cost numeric);
       delete from sd_standard_cost_extra_fabric where product_code=p_code;
       insert into sd_standard_cost_extra_fabric(product_code,fabric_code,size,position,uom,consumption,fabric_cost)
         select p_code,x.fabric_code,x.size,x.position,x.uom,x.consumption,x.fabric_cost from jsonb_to_recordset(r.payload#>'{fabric,extras}') as x(fabric_code text,size text,position integer,uom text,consumption numeric,fabric_cost numeric);
     end if;
     if 'cmtp'=any(applied) then
       delete from sd_cmtp_component where product_code=p_code;
       insert into sd_cmtp_component(product_code,category,label,amount,position)
         select p_code,x.category,x.label,x.amount,x.position from jsonb_to_recordset(r.payload->'cmtp') as x(category text,label text,amount numeric,position integer);
       update sd_standard_cost set cm_cost=(select sum(amount) from sd_cmtp_component where product_code=p_code) where product_code=p_code;
     end if;
     if 'documents'=any(applied) then
       update sd_standard_cost set rfp_link=r.payload#>>'{documents,rfp_link}',cad_link=nullif(r.payload#>>'{documents,cad_link}','') where product_code=p_code;
       -- Keep storage objects for immutable historical snapshots even when a document is removed.
       delete from sd_cost_document where product_code=p_code;
       insert into sd_cost_document(product_code,file_path,file_name,file_size,doc_group,width,link_url,remark,created_by)
         select p_code,x.file_path,x.file_name,x.file_size,x.doc_group,x.width,x.link_url,x.remark,p_actor from jsonb_to_recordset(r.payload#>'{documents,files}') as x(file_path text,file_name text,file_size bigint,doc_group text,width text,link_url text,remark text);
     end if;
     r.approved_sections:=r.approved_sections||applied;
     if r.sections <@ r.approved_sections then r.status:='approved'; end if;
     update sd_standard_cost set status='approved',neg_stage='signed_off',documented=true,approved_by=p_actor,approved_at=now(),updated_at=now() where product_code=p_code;
     perform set_config('sd.cost_workflow','',true);
   else
     if nullif(trim(p_reason),'') is null then raise exception 'A decision remark is required'; end if;
     r.status:=case when p_op='reject' then 'rejected' else 'rework' end;
   end if;
 else raise exception 'Unknown workflow action';
 end if;
 update sd_cost_revision set payload=r.payload,reason=r.reason,reference_code=r.reference_code,sections=r.sections,
   approved_sections=r.approved_sections,status=r.status,version=version+1,updated_at=now() where id=r.id;
 insert into sd_cost_revision_event(revision_id,product_code,event,actor,reason,sections,before_data,after_data)
 values(r.id,p_code,p_op,p_actor,coalesce(nullif(trim(p_reason),''),r.reason),coalesce(applied,r.sections),previous,
   (select to_jsonb(x) from sd_cost_revision x where x.id=r.id));
 return r.id;
end $$;
revoke all on function public.sd_cost_workflow(text,text,bigint,integer,jsonb,text,text,text[],text,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.sd_cost_workflow(text,text,bigint,integer,jsonb,text,text,text[],text,boolean,jsonb) to service_role;

