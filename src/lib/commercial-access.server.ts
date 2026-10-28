import 'server-only';
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
export async function commercialPos(vendorCode: string): Promise<CommercialPo[]> {
  const code = vendorCode.trim().toUpperCase();
  if (!code) return [];
  const db = createAdminClient();
  const { data: rows } = await pageAll<CommercialPo>(() => db.from('sd_po_filtered').select('po_ref_num,vendor_code,po_date,po_status').eq('vendor_code', code).in('po_status', ['Approved', 'Completed']).order('po_detail_id'));
  return [...new Map(rows.filter((p) => p.po_ref_num).map((p) => [p.po_ref_num, p])).values()];
}
