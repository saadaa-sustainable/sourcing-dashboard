import 'server-only';
import { createAdminClient } from '@/lib/supabase/admin';
import { commercialActor } from '@/lib/commercial-access.server';
import { pageAll } from './_shared';
import type { VendorCommercialRequest } from '../types';

export type CommercialEvent = { id: number; request_id: number; actor_email: string; occurred_at: string; before_values: Record<string, unknown> | null; after_values: Record<string, unknown> };
export type CommercialAccount = { user_id: string; email: string; vendor_code: string; is_active: boolean };
export async function loadVendorCommercial() {
  const actor = await commercialActor();
  if (!actor) throw new Error('Commercial access required.');
  const db = createAdminClient();
  const requests = await pageAll<VendorCommercialRequest>(() => {
    const query = db.from('sd_vendor_commercial_request' as never).select('*').order('id', { ascending: false });
    return actor.vendorCode ? query.eq('vendor_code', actor.vendorCode) : query;
  });
  // Read events through the real session's RLS; do not load other vendors' events in the service client.
  const { createSessionClient } = await import('@/lib/supabase/server');
  const session = await createSessionClient();
  const [events, vendors, accounts] = await Promise.all([
    pageAll<CommercialEvent>(() => session.from('sd_commercial_request_event' as never).select('*').order('id')),
    actor.vendorCode ? Promise.resolve([{ vendor_code: actor.vendorCode, vendor_name: actor.vendorName, primary_type: null }])
      : pageAll<{ vendor_code: string; vendor_name: string | null; primary_type: string | null }>(() => db.from('vendor_master_data').select('vendor_code,vendor_name,primary_type').eq('is_active', true).order('vendor_code')),
    actor.role === 'admin' ? pageAll<CommercialAccount>(() => db.from('sd_commercial_vendor_account' as never).select('user_id,email,vendor_code,is_active').order('user_id')) : Promise.resolve([]),
  ]);
  return { ready: true, requests, vendors, events, accounts, actor };
}
