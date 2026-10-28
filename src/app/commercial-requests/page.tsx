import { redirect } from 'next/navigation';
import { commercialIdentity, commercialPos } from '@/lib/commercial-access.server';
import { loadVendorCommercial } from '@/lib/forms/queries-modules/vendor-commercial';
import { VendorCommercialClient } from '../vendor-commercial/vendor-commercial-client';
import { vendorCommercialSignOut } from './session-actions';
import { Notice } from '@/components/forms/form-layout';
import '../vendor-commercial/commercial.css';

export const dynamic = 'force-dynamic';
export default async function CommercialRequestsPage() {
  let actor;
  try { actor = await commercialIdentity(); }
  catch { return <main className="commercial-portal ui-shopify"><Notice tone="error">Commercial Requests is not available. Contact SAADAA to check your access and database setup.</Notice></main>; }
  if (!actor) redirect('/commercial-requests/login');
  if (actor.passwordChangeRequired) redirect('/commercial-requests/change-password');
  if (!actor.vendorCode) redirect('/vendor-commercial');
  let content;
  try {
    const [data, initialPos] = await Promise.all([loadVendorCommercial(), commercialPos(actor.vendorCode)]);
    content = <VendorCommercialClient {...data} initialPos={initialPos} role="viewer" />;
  } catch { content = <Notice tone="error">Could not load your requests. Please retry or contact SAADAA.</Notice>; }
  return <main className="commercial-portal ui-shopify"><header><div><h1>Commercial Approval Requests</h1><p>{actor.vendorName} · {actor.vendorCode} · {actor.email}</p></div><form action={vendorCommercialSignOut}><button className="wf-btn wf-btn-ghost">Sign out</button></form></header>{content}</main>;
}
