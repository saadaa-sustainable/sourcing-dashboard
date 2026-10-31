'use server';
import { revalidatePath } from 'next/cache';
import { currentUser } from '@/lib/forms/queries';
import { client } from '@/lib/forms/queries-modules/_shared';
export async function saveBuyingPlanApprovalRule(form: FormData) {
 const actor=await currentUser();
 if(actor?.role!=='admin') return {ok:false,error:'Only an admin can change approval rules.'};
 const l1=String(form.get('l1_email')??'').trim().toLowerCase();
 const l2=String(form.get('l2_email')??'').trim().toLowerCase();
 const raw=String(form.get('max_value')??'').trim();
 if(!l1||!l2||l1===l2) return {ok:false,error:'Select two different active users for L1 and L2.'};
 if(!/^\d+(\.\d{1,2})?$/.test(raw)||Number(raw)>1e12) return {ok:false,error:'Enter a non-negative INR value with up to two decimal places (maximum 1 trillion).'};
 const db=await client();
 // paging-ok: restricted to two distinct selected user emails, at most two rows
 const {data:users,error:lookupError}=await db.from('sd_user').select('email,role,is_active').in('email',[l1,l2]);
 if(lookupError) return {ok:false,error:lookupError.message};
 if(users?.length!==2||users.some(u=>!u.is_active||!['team','admin'].includes(u.role))) return {ok:false,error:'Both approvers must be active dashboard team or admin users.'};
 const {error}=await db.from('sd_buying_plan_approval_rule').upsert({id:1,l1_email:l1,l2_email:l2,max_value:Number(raw),updated_by:actor.email,updated_at:new Date().toISOString()},{onConflict:'id'});
 if(error) return {ok:false,error:['42P01','PGRST205'].includes(error.code)?'The Buying Plan approval settings migration must be applied before this rule can be saved.':error.message};
 revalidatePath('/rules-master');revalidatePath('/buying-plan');revalidatePath('/approvals');
 return {ok:true};
}
