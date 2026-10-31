import 'server-only';
import { COMMERCIAL_PO_CREATED_FROM } from './commercial-po-eligibility';
import { cache } from 'react';
import { createSessionClient } from './supabase/server';
import { createAdminClient } from './supabase/admin';
import { pageAll } from './supabase/page-all';
import { canView } from './views';
import type { SdRole } from './forms/types';
import { isCommercialGoogleSession } from './commercial-google';

export type CommercialActor = { email: string; uid: string; role: SdRole; vendorCode: string | null; vendorName: string | null; allowedPages?: string[] | null; passwordChangeRequired?: boolean; googleSession?: boolean };

/** No local auth bypass and no user-editable metadata in commercial authorization. */
export const commercialIdentity = cache(async (): Promise<CommercialActor | null> => {
  const session = await createSessionClient();
  const { data: { user }, error } = await session.auth.getUser();
  if (error || !user?.email) return null;
  const email = user.email.toLowerCase();
  const db = createAdminClient();
  if (email.endsWith('@saadaa.in')) {
    const { data: staff, error: staffError } = await db.from('sd_user').select('role,is_active').eq('email', email).maybeSingle();
    if (staffError) throw new Error('Unable to verify commercial access.');
    if (staff?.is_active) {
      // paging-ok: assignments for this single user only
      const { data: assignments, error: roleError } = await db.from('sd_user_role').select('sd_custom_role(pages)').eq('user_email', email);
      if (roleError) throw new Error('Unable to verify commercial page access.');
      const pages = (assignments ?? []).flatMap((r) => {
        const role = r.sd_custom_role as unknown as { pages: string[] } | null;
        return role?.pages ?? [];
      });
      if (!canView('/vendor-commercial', staff.role as SdRole, assignments?.length ? pages : null)) return null;
      return { email, uid: user.id, role: staff.role as SdRole, vendorCode: null, vendorName: null, allowedPages: assignments?.length ? pages : null };
    }
  }
  const { data: mapping, error: mappingError } = await db.from('sd_commercial_vendor_account' as never).select('*').eq('user_id', user.id).eq('is_active', true).maybeSingle();
  if (mappingError) throw new Error('Commercial Requests needs its vendor-portal database migration.');
  if (!mapping) return null;
  const code = (mapping as { vendor_code: string }).vendor_code;
  const { data: vendor, error: vendorError } = await db.from('vendor_master_data').select('vendor_code,vendor_name,is_active').eq('vendor_code', code).maybeSingle();
  if (vendorError) throw new Error('Unable to verify vendor identity.');
  if (!vendor?.is_active) return null;
  let googleSession = false;
  if (user.identities?.some((identity) => identity.provider === 'google')) {
    const { data: verified, error: claimsError } = await session.auth.getClaims();
    googleSession = !claimsError && isCommercialGoogleSession(verified?.claims, user.id);
  }
  return { email, uid: user.id, role: 'viewer', vendorCode: code, vendorName: vendor.vendor_name, googleSession, passwordChangeRequired: user.app_metadata?.commercial_password_change_required === true && !googleSession };
});

/** Every request/data/file action uses this gate; temporary-password sessions have no module access. */
export const commercialActor = cache(async (): Promise<CommercialActor | null> => {
  const actor = await commercialIdentity();
  return actor?.passwordChangeRequired ? null : actor;
});

export type CommercialPo = { po_ref_num: string; vendor_code: string; po_date: string | null; po_status: string | null };
export async function commercialPos(vendorCode: string, retainedReference?: string): Promise<CommercialPo[]> {
  const code = vendorCode.trim().toUpperCase();
  if (!code) return [];
  const db = createAdminClient();
  const { data: rows } = await pageAll<CommercialPo>(() => db.from('sd_po_filtered').select('po_ref_num,vendor_code,po_date,po_status').eq('vendor_code', code).in('po_status', ['Approved', 'Completed']).gte('po_date', COMMERCIAL_PO_CREATED_FROM).order('po_detail_id'));
  // Existing unapproved requests can retain their saved PO while other fields are amended.
  // The cutoff applies to new selections, including any replacement PO on an old request.
  if (retainedReference && !rows.some(po => po.po_ref_num === retainedReference)) {
    const {data:retained}=await pageAll<CommercialPo>(()=>db.from('sd_po_filtered').select('po_ref_num,vendor_code,po_date,po_status').eq('vendor_code',code).eq('po_ref_num',retainedReference).in('po_status',['Approved','Completed']).order('po_detail_id'));
    rows.push(...retained);
  }
  const candidates=[...new Map(rows.filter(po=>po.po_ref_num).map(po=>[po.po_ref_num,po])).values()];
  const references=[...new Set(candidates.map(po=>po.po_ref_num.trim()).filter(Boolean))];
  const closed=new Set<string>();
  for(let offset=0;offset<references.length;offset+=100) {
    const batch=references.slice(offset,offset+100);
    // Match the FG Closer Closed view: immutable snapshots plus workflow rows
    // marked Closed, including older closures whose snapshot was never saved.
    const [snapshots,workflows]=await Promise.all([
      pageAll<{po_ref_num:string|null}>(()=>db.schema('FG Closer').from('fg_closed_po').select('po_ref_num').in('po_ref_num',batch).order('id')),
      pageAll<{po_ref_num:string|null}>(()=>db.schema('FG Closer').from('fg_po_closure_requests').select('po_ref_num').in('po_ref_num',batch).eq('status','Closed').order('id')),
    ]);
    for(const row of [...snapshots.data,...workflows.data]) if(row.po_ref_num?.trim()) closed.add(row.po_ref_num.trim());
  }
  // Only the saved reference on an existing editable request may be retained.
  // New requests / changed selections must pass the current closure checks.
  return candidates.filter(po=>po.po_ref_num===retainedReference || !closed.has(po.po_ref_num.trim()));
}
