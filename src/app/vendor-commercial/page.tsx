import { redirect } from 'next/navigation';
import { FormLayout, Notice } from '@/components/forms/form-layout';
import { commercialActor } from '@/lib/commercial-access.server';
import { loadVendorCommercial } from '@/lib/forms/queries-modules/vendor-commercial';
import { VendorCommercialClient } from './vendor-commercial-client';
import './commercial.css';

export const dynamic = 'force-dynamic';
export default async function VendorCommercialPage() {
  let actor;
  try { actor = await commercialActor(); }
  catch { return <main className="commercial-portal ui-shopify"><Notice tone="warn">Commercial Requests requires the vendor-portal database migration and configured authentication. Contact the administrator.</Notice></main>; }
  if (!actor) redirect('/login');
  if (actor.vendorCode) redirect('/commercial-requests');
  let content;
  try {
    const data = await loadVendorCommercial();
    content = <VendorCommercialClient {...data} role={actor.role} />;
  } catch {
    content = <Notice tone="error">Could not load Commercial Requests. Check the database migration and connection, then reload.</Notice>;
  }
  return <FormLayout title="Commercial Approval Requests" subtitle="Review vendor requests, record commercial decisions and track Finance processing." active="/vendor-commercial" role={actor.role} userEmail={actor.email} allowedPages={actor.allowedPages ?? null}>{content}</FormLayout>;
}
